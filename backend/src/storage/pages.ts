import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { env } from '../env.js';
import { logger } from '../log.js';
import { ensureBucket as ensureS3Bucket, getObject, putObject, s3Client } from './s3.js';

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

// --- S3 (MinIO) ---------------------------------------------------------------

function s3Store(): PageStore {
  const bucket = env.rawPageBucket;
  return {
    put: (objectPath, body) => putObject(bucket, objectPath, body, { contentType: 'application/gzip' }),
    get: (objectPath) => getObject(bucket, objectPath),
    describe() {
      s3Client(); // throws the "not configured" error rather than describing a store that isn't there
      return `s3 ${env.s3Endpoint} bucket "${bucket}"`;
    },
  };
}

/**
 * Create the bucket if it is not there yet. Private: crawled HTML is working
 * material, not something to serve publicly.
 */
export async function ensureBucket(): Promise<string> {
  if (storeKind() === 'file') return `local directory ${path.resolve(env.rawPageDir)}`;

  const bucket = env.rawPageBucket;
  const { created } = await ensureS3Bucket(bucket, { public: false });
  return created ? `created private bucket "${bucket}"` : `bucket "${bucket}" already exists`;
}

// --- Local filesystem -------------------------------------------------------

/**
 * For local work and for tests, which must not need an object store to run.
 * Not a second production target: deployments use the s3 driver.
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

/** The configured driver. An unknown value fails loudly rather than falling through to s3. */
function storeKind(): 'file' | 's3' {
  const kind = env.rawPageStore;
  if (kind === 'file' || kind === 's3') return kind;
  throw new Error(`RAW_PAGE_STORE="${kind}" is not a storage driver: use "s3" (the default) or "file".`);
}

function pageStore(): PageStore {
  if (!store) store = storeKind() === 'file' ? fileStore() : s3Store();
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
