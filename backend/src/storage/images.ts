import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('images');

/**
 * Recipe photos, mirrored into our own object storage.
 *
 * Why mirror at all, when the crawl already has a URL: hotlinking another
 * site's CDN means their bandwidth, their rate limits, their hotlink
 * protection, and a broken card the day they reorganise. A stored copy is also
 * the only version we can resize, cache and serve from the same project as
 * everything else.
 *
 * This bucket is PUBLIC, which is the one way it differs from storage/pages.ts:
 * the app renders these in an <Image> with no session, so the object has to be
 * readable by an anonymous GET.
 *
 * Mirroring does not decide whether a photo may be republished - sources.allow_image_use
 * does, and images/run.ts checks it before anything is downloaded.
 */

/** What the storage API will accept from us, and the app will render. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

export function isSupportedImageType(contentType: string): boolean {
  return normalizeType(contentType) in EXTENSION_BY_TYPE;
}

function normalizeType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/**
 * Content-addressed, exactly like raw pages: the same photo reached from two
 * recipes is stored once, and re-running the stage overwrites an object with
 * its own bytes instead of accumulating copies.
 */
export function pathForImage(bytes: Uint8Array, contentType: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const extension = EXTENSION_BY_TYPE[normalizeType(contentType)] ?? 'jpg';
  return `${hash.slice(0, 2)}/${hash}.${extension}`;
}

function config(): { url: string; key: string; bucket: string } {
  const url = env.supabaseUrl;
  const key = env.supabaseServiceRoleKey;
  if (!url || !key) {
    throw new Error(
      'Image storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  return { url, key, bucket: env.recipeImageBucket };
}

function auth(key: string): Record<string, string> {
  // Storage wants both: `apikey` identifies the project, the bearer carries the
  // role. The service role is what may write to a bucket the app only reads.
  return { apikey: key, authorization: `Bearer ${key}` };
}

/**
 * The base the app's EXPO_PUBLIC_STORAGE_URL must be set to. Printed by
 * `npm run dev -- images check` so the two halves cannot be guessed apart.
 */
export function publicBaseUrl(): string {
  const { url, bucket } = config();
  return `${url}/storage/v1/object/public/${bucket}`;
}

/** The URL one stored object is served at. */
export function publicUrlFor(objectPath: string): string {
  return `${publicBaseUrl()}/${objectPath}`;
}

/** Create the bucket if it is missing. Public, and capped at IMAGE_MAX_BYTES. */
export async function ensureImageBucket(): Promise<string> {
  const { url, key, bucket } = config();
  const headers = { ...auth(key), 'content-type': 'application/json' };

  const existing = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers });
  if (existing.ok) {
    const body = (await existing.json()) as { public?: boolean };
    // A private bucket here is a silent failure: every image 400s for the app
    // while the pipeline reports success, so say so rather than carry on.
    if (!body.public) {
      return `bucket "${bucket}" exists but is PRIVATE - the app cannot read it. ` +
        'Make it public in the Supabase dashboard, or set RECIPE_IMAGE_BUCKET to another name.';
    }
    return `bucket "${bucket}" already exists (public)`;
  }

  const created = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: bucket,
      id: bucket,
      public: true,
      file_size_limit: env.imageMaxBytes,
      allowed_mime_types: Object.keys(EXTENSION_BY_TYPE),
    }),
  });
  if (!created.ok) {
    throw new Error(
      `could not create bucket "${bucket}" (${created.status}): ${await created.text()}`,
    );
  }
  return `created public bucket "${bucket}"`;
}

/** Store one image and return the object path to keep on the row. */
export async function storeImage(bytes: Uint8Array, contentType: string): Promise<string> {
  const { url, key, bucket } = config();
  const objectPath = pathForImage(bytes, contentType);

  const response = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      ...auth(key),
      'content-type': normalizeType(contentType),
      // Content-addressed keys mean a repeat write is the same bytes, so
      // overwriting is always safe and never loses anything.
      'x-upsert': 'true',
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: bytes,
    signal: AbortSignal.timeout(env.crawlTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(
      `image upload failed (${response.status}) for ${objectPath}: ${await response.text()}`,
    );
  }

  log.debug(`stored ${objectPath} (${bytes.byteLength} bytes)`);
  return objectPath;
}
