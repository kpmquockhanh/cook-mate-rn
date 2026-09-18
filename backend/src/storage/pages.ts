import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('storage');

/**
 * Where a crawled page's bytes live.
 *
 * Pages are content-addressed and gzipped: the object key is derived from the
 * SHA-256 already stored on the row, so the same HTML reached by two URLs is
 * stored once, and re-storing an unchanged page overwrites itself rather than
 * accumulating copies. Nothing outside this module knows the layout - callers
 * hold a `storage_path` and hand it back.
 */
export function pathForContent(contentHash: string): string {
  // Two-character prefix keeps any one directory listing manageable, which
  // matters for the filesystem driver and costs nothing for object storage.
  return `${contentHash.slice(0, 2)}/${contentHash}.html.gz`;
}

interface PageStore {
  put(objectPath: string, body: Uint8Array): Promise<void>;
  get(objectPath: string): Promise<Uint8Array | null>;
  describe(): string;
}

// --- Supabase Storage -------------------------------------------------------

function supabaseConfig(): { url: string; key: string; bucket: string } {
  const url = env.supabaseUrl;
  const key = env.supabaseServiceRoleKey;
  if (!url || !key) {
    throw new Error(
      'Raw page storage is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
        'For local work without Supabase, set RAW_PAGE_STORE=file. See backend/.env.example.',
    );
  }
  return { url, key, bucket: env.rawPageBucket };
}

function supabaseStore(): PageStore {
  const object = (objectPath: string) => {
    const { url, bucket } = supabaseConfig();
    return `${url}/storage/v1/object/${bucket}/${objectPath}`;
  };
  const auth = () => {
    const { key } = supabaseConfig();
    // Storage wants both: `apikey` identifies the project, the bearer token
    // carries the role. The service role is what lets the crawler write to a
    // bucket the app's users cannot.
    return { apikey: key, authorization: `Bearer ${key}` };
  };

  return {
    async put(objectPath, body) {
      const response = await fetch(object(objectPath), {
        method: 'POST',
        headers: {
          ...auth(),
          'content-type': 'application/gzip',
          // Content-addressed keys mean a repeat write is the same bytes, so
          // overwriting is always safe and never loses anything.
          'x-upsert': 'true',
        },
        body,
        signal: AbortSignal.timeout(env.crawlTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `storage upload failed (${response.status}) for ${objectPath}: ${await response.text()}`,
        );
      }
    },

    async get(objectPath) {
      const response = await fetch(object(objectPath), {
        headers: auth(),
        signal: AbortSignal.timeout(env.crawlTimeoutMs),
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`storage read failed (${response.status}) for ${objectPath}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    describe() {
      const { url, bucket } = supabaseConfig();
      return `supabase ${url}/storage/v1 bucket "${bucket}"`;
    },
  };
}

/**
 * Create the bucket if it is not there yet. Private: crawled HTML is working
 * material, not something to serve publicly.
 */
export async function ensureBucket(): Promise<string> {
  if (env.rawPageStore === 'file') return `local directory ${path.resolve(env.rawPageDir)}`;

  const { url, key, bucket } = supabaseConfig();
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  const existing = await fetch(`${url}/storage/v1/bucket/${bucket}`, { headers });
  if (existing.ok) return `bucket "${bucket}" already exists`;

  const created = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: bucket, id: bucket, public: false }),
  });
  if (!created.ok) {
    throw new Error(`could not create bucket "${bucket}" (${created.status}): ${await created.text()}`);
  }
  return `created private bucket "${bucket}"`;
}

// --- Local filesystem -------------------------------------------------------

/**
 * For local work and for tests, which must not need a Supabase project to run.
 * Not a second production target: the deployed crawler uses Supabase Storage,
 * same project as auth and the app tables.
 */
function fileStore(): PageStore {
  const root = path.resolve(env.rawPageDir);
  return {
    async put(objectPath, body) {
      const target = path.join(root, objectPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    },
    async get(objectPath) {
      try {
        return new Uint8Array(await readFile(path.join(root, objectPath)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    describe() {
      return `local directory ${root}`;
    },
  };
}

// --- The one accessor -------------------------------------------------------

let store: PageStore | null = null;

function pageStore(): PageStore {
  if (!store) store = env.rawPageStore === 'file' ? fileStore() : supabaseStore();
  return store;
}

/** Test seam: forget the driver so a changed environment is picked up. */
export function resetPageStore(): void {
  store = null;
}

export function describeStore(): string {
  return pageStore().describe();
}

/** Store a page's HTML and return the path to hand back to `readPage`. */
export async function writePage(contentHash: string, html: string): Promise<string> {
  const objectPath = pathForContent(contentHash);
  await pageStore().put(objectPath, gzipSync(Buffer.from(html, 'utf8')));
  return objectPath;
}

/** Read a page's HTML back, or null when the object is gone. */
export async function readPage(objectPath: string): Promise<string | null> {
  const bytes = await pageStore().get(objectPath);
  if (!bytes) {
    log.warn(`no object at ${objectPath}`);
    return null;
  }
  return gunzipSync(bytes).toString('utf8');
}
