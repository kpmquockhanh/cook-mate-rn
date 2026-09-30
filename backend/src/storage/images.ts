import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../log.js';
import { ensureBucket as ensureS3Bucket, putObject } from './s3.js';

const log = logger('images');

/**
 * Recipe photos, mirrored into our own object storage.
 *
 * Why mirror at all, when the crawl already has a URL: hotlinking another
 * site's CDN means their bandwidth, their rate limits, their hotlink
 * protection, and a broken card the day they reorganise. A stored copy is also
 * the only version we can resize, cache and serve from storage we run ourselves.
 *
 * This bucket is PUBLIC, which is the one way it differs from storage/pages.ts:
 * the app renders these in an <Image> with no session, so the object has to be
 * readable by an anonymous GET.
 *
 * Mirroring does not decide whether a photo may be republished - sources.allow_image_use
 * does, and images/run.ts checks it before anything is downloaded.
 */

/** What we store, and the app will render. */
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

/**
 * The base the app's EXPO_PUBLIC_STORAGE_URL must be set to. Printed by
 * `npm run dev -- images --check` so the two halves cannot be guessed apart.
 * Path-style: MinIO serves `<public url>/<bucket>/<key>`.
 */
export function publicBaseUrl(): string {
  const base = env.s3PublicUrl;
  if (!base) throw new Error('Image storage is not configured: set S3_PUBLIC_URL or S3_ENDPOINT.');
  return `${base}/${env.recipeImageBucket}`;
}

/** The URL one stored object is served at. */
export function publicUrlFor(objectPath: string): string {
  return `${publicBaseUrl()}/${objectPath}`;
}

/**
 * Create the bucket if it is missing, readable by anyone. Size and type limits
 * are not set on the bucket: images/run.ts enforces IMAGE_MAX_BYTES and
 * isSupportedImageType before anything is uploaded.
 */
export async function ensureImageBucket(): Promise<string> {
  const bucket = env.recipeImageBucket;
  const { created, publicPolicy } = await ensureS3Bucket(bucket, { public: true });
  const state = created ? `created public bucket "${bucket}"` : `bucket "${bucket}" already exists`;
  // A bucket nobody can read is a silent failure: every image 403s for the
  // app while the pipeline reports success, so say so rather than carry on.
  if (publicPolicy === 'missing') {
    return (
      `${state} but is NOT publicly readable - the app cannot load its images. ` +
      `Grant anonymous read with \`mc anonymous set download <alias>/${bucket}\`, ` +
      'or set RECIPE_IMAGE_BUCKET to a new name and let the backend create it.'
    );
  }
  return `${state} (public)`;
}

/** Store one image and return the object path to keep on the row. */
export async function storeImage(bytes: Uint8Array, contentType: string): Promise<string> {
  const objectPath = pathForImage(bytes, contentType);
  await putObject(env.recipeImageBucket, objectPath, bytes, {
    contentType: normalizeType(contentType),
    cacheControl: 'public, max-age=31536000, immutable',
  });
  log.debug(`stored ${objectPath} (${bytes.byteLength} bytes)`);
  return objectPath;
}
