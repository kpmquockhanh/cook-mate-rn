# MinIO Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the backend's Supabase Storage REST calls with an S3 client pointed at a self-hosted MinIO, for raw pages (private bucket) and recipe images (public bucket).

**Architecture:** A new `backend/src/storage/s3.ts` is the only file that imports `@aws-sdk/client-s3`. It moves bytes and ensures buckets exist. `pages.ts` and `images.ts` keep their public functions and key layout and swap their Supabase `fetch` calls for `s3.ts`. MinIO runs as a service in the root `docker-compose.yml`. The app changes only its `EXPO_PUBLIC_STORAGE_URL` value.

**Tech Stack:** Node 22, TypeScript run by `tsx`, `@aws-sdk/client-s3` v3, `node:test`, MinIO (`minio/minio` image), docker compose.

**Spec:** `docs/superpowers/specs/2026-09-30-minio-storage-design.md`

## Global Constraints

- Branch: `minio-storage`. Never commit `README.md`, `app.json`, `CLAUDE.md` or `backend/CLAUDE.md`: they hold the user's own uncommitted edits. Stage files by explicit path, never `git add -A` or `git add .`.
- Never read `.env` files. Edit `.env.example` files only as the plan says. If a permission prompt denies it, skip that edit and record it in your report as a user action. Do not work around the denial.
- Do not run migrations, `npm run setup` or anything else against the user's database.
- Tests use `node:test` via `tsx --test`. `cd backend && npm test` must pass with no MinIO, no database and no network.
- `backend/src/env.ts` does `import 'dotenv/config'`, which loads the developer's `backend/.env` into tests. dotenv never overrides a key that already exists, so tests that need a variable absent set it to `''`, not `delete`.
- Object keys are unchanged: raw pages `ab/<sha256>.html.gz`, images `ab/<sha256>.<ext>`.
- Image uploads keep `cache-control: public, max-age=31536000, immutable`.
- The S3 client uses `forcePathStyle: true`.
- Environment variables (exact names): `S3_ENDPOINT`, `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` (defaults to `S3_ENDPOINT`), `RAW_PAGE_STORE` (`s3` default, or `file`). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are removed. Compose uses `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`.
- The public bucket policy grants only `s3:GetObject` to `*` on `arn:aws:s3:::<bucket>/*`. It is written only on a bucket the backend just created. An existing bucket's policy is never overwritten.
- `backend/src/db.ts` and anything about Postgres is out of scope (sub-project 3).
- Commit messages follow the repo's style: a sentence-case summary line with no `feat:` prefix, ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Leftover `RAW_PAGE_STORE=supabase` in someone's `.env`.** Expected: a clear error naming the valid values, not a silent switch to s3. Pinned by a test in Task 2.
2. **`S3_PUBLIC_URL` or `S3_ENDPOINT` written with a trailing slash.** Expected: image URLs come out as `http://host:9000/recipe-images`, never `//recipe-images`. Pinned by a test in Task 3.
3. **A public bucket whose policy was set by hand with `mc anonymous set download`.** MinIO stores that policy in the array form (`Principal: {AWS: ["*"]}`). Expected: reported `ok`, not `missing`. Pinned in Task 1.
4. **MinIO accepting a connection and then hanging on an upload.** Expected: the upload aborts after `CRAWL_TIMEOUT_MS`. Pinned in Task 1 by asserting that an abort signal is passed.
5. **`setup` or `images --check` run before any `S3_*` values are set.** Expected: one message naming every missing variable. `setup` logs it as a warning and still completes. Pinned by the configuration test in Task 1 and the manual check in Task 3.

---

### Task 1: S3 client module

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json` (via npm)
- Modify: `backend/src/env.ts` (the "Raw page storage" block, currently around lines 171–188)
- Create: `backend/src/storage/s3.ts`
- Test: `backend/test/s3.test.ts`

**Interfaces:**
- Consumes: `env.crawlTimeoutMs` (existing).
- Produces, from `src/env.ts`: getters `env.s3Endpoint: string | undefined`, `env.s3Region: string`, `env.s3AccessKeyId: string | undefined`, `env.s3SecretAccessKey: string | undefined`, `env.s3PublicUrl: string | undefined`, `env.rawPageStore: string`. `env.supabaseUrl` and `env.supabaseServiceRoleKey` are removed. `pages.ts` and `images.ts` still reference them and won't typecheck until Tasks 2 and 3 land. The test run in this task doesn't import those files.
- Produces, from `src/storage/s3.ts`:
  - `setS3ClientForTests(fake: S3Like | null): void`
  - `s3Client(): S3Like`
  - `putObject(bucket: string, key: string, body: Uint8Array, options: { contentType: string; cacheControl?: string }): Promise<void>`
  - `getObject(bucket: string, key: string): Promise<Uint8Array | null>`
  - `ensureBucket(bucket: string, options: { public: boolean }): Promise<BucketReport>`
  - `interface BucketReport { created: boolean; publicPolicy: 'ok' | 'set' | 'missing' | 'n/a' }`
  - `S3Like` is `{ send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> }`

- [ ] **Step 1: Install the SDK**

Run: `cd backend && npm install @aws-sdk/client-s3@^3.1143.0`
Expected: `package.json` gains `"@aws-sdk/client-s3": "^3.1143.0"` under `dependencies`, and npm reports 0 vulnerabilities.

- [ ] **Step 2: Replace the storage block in `backend/src/env.ts`**

Replace everything from the line `  // ---- Raw page storage (src/storage/pages.ts) ----` up to (not including) `  // ---- Recipe images (src/storage/images.ts) ----` with:

```ts
  // ---- Object storage (src/storage/s3.ts) ----
  // Raw pages and recipe images live in an S3-compatible store - MinIO from
  // docker-compose.yml locally. Getters, so tests can change them per case.
  //
  // The S3 API the backend talks to, e.g. http://localhost:9000 (compose
  // overrides it to http://minio:9000 inside its containers).
  get s3Endpoint() {
    return process.env.S3_ENDPOINT?.replace(/\/+$/, '') || undefined;
  },
  // MinIO accepts any region, but the SDK will not sign without one.
  get s3Region() {
    return process.env.S3_REGION || 'us-east-1';
  },
  get s3AccessKeyId() {
    return process.env.S3_ACCESS_KEY_ID || undefined;
  },
  get s3SecretAccessKey() {
    return process.env.S3_SECRET_ACCESS_KEY || undefined;
  },
  // Where clients read public objects. Differs from the endpoint when the
  // backend reaches MinIO by a container name but a phone needs a LAN address.
  get s3PublicUrl() {
    return (
      process.env.S3_PUBLIC_URL?.replace(/\/+$/, '') ||
      process.env.S3_ENDPOINT?.replace(/\/+$/, '') ||
      undefined
    );
  },

  // ---- Raw page storage (src/storage/pages.ts) ----
  // Crawled HTML lives in object storage, not in a Postgres column: it is the
  // largest thing the pipeline keeps and the least often read.
  rawPageBucket: process.env.RAW_PAGE_BUCKET ?? 'raw-pages',
  // `file` keeps pages on disk instead, for local work and for tests, which
  // must not need an object store to run. Deployments use the default, `s3`.
  get rawPageStore() {
    return (process.env.RAW_PAGE_STORE || 's3').toLowerCase();
  },
  rawPageDir: process.env.RAW_PAGE_DIR ?? '.raw-pages',

```

- [ ] **Step 3: Write the failing tests** in `backend/test/s3.test.ts`

```ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// Set before anything reads them, and set to '' rather than deleted so
// dotenv (which never overrides an existing key) cannot fill them in from a
// developer's backend/.env.
process.env.S3_ENDPOINT = '';
process.env.S3_ACCESS_KEY_ID = '';
process.env.S3_SECRET_ACCESS_KEY = '';

const s3 = await import('../src/storage/s3.js');

type Handler = (command: unknown) => unknown;

/** A stand-in for S3Client: records every command (and its options) and answers with `handler`. */
function fakeClient(handler: Handler = () => ({})) {
  const sent: unknown[] = [];
  const options: ({ abortSignal?: AbortSignal } | undefined)[] = [];
  s3.setS3ClientForTests({
    async send(command: unknown, sendOptions?: { abortSignal?: AbortSignal }) {
      sent.push(command);
      options.push(sendOptions);
      return handler(command);
    },
  });
  return Object.assign(sent, { options });
}

/** An error shaped like the SDK's: a name plus the HTTP status in $metadata. */
function sdkError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

afterEach(() => {
  s3.setS3ClientForTests(null);
});

test('putObject sends the bucket, key, body, content type and cache control', async () => {
  const sent = fakeClient();
  const body = new Uint8Array([1, 2, 3]);

  await s3.putObject('recipe-images', 'ab/abc.png', body, {
    contentType: 'image/png',
    cacheControl: 'public, max-age=31536000, immutable',
  });

  assert.equal(sent.length, 1);
  const command = sent[0];
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, 'recipe-images');
  assert.equal(command.input.Key, 'ab/abc.png');
  assert.equal(command.input.Body, body);
  assert.equal(command.input.ContentType, 'image/png');
  assert.equal(command.input.CacheControl, 'public, max-age=31536000, immutable');
});

test('reads and writes carry an abort signal, so a hung store cannot stall a run', async () => {
  const sent = fakeClient(() => ({ Body: { transformToByteArray: async () => new Uint8Array() } }));
  await s3.putObject('raw-pages', 'aa/x.html.gz', new Uint8Array(), { contentType: 'application/gzip' });
  await s3.getObject('raw-pages', 'aa/x.html.gz');
  assert.ok(sent.options[0]?.abortSignal instanceof AbortSignal);
  assert.ok(sent.options[1]?.abortSignal instanceof AbortSignal);
});

test('getObject returns the object bytes', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const sent = fakeClient(() => ({ Body: { transformToByteArray: async () => bytes } }));

  assert.deepEqual(await s3.getObject('raw-pages', 'aa/x.html.gz'), bytes);
  const command = sent[0];
  assert.ok(command instanceof GetObjectCommand);
  assert.equal(command.input.Bucket, 'raw-pages');
  assert.equal(command.input.Key, 'aa/x.html.gz');
});

test('a missing object reads as null, whether the SDK says NoSuchKey or just 404', async () => {
  fakeClient(() => {
    throw sdkError('NoSuchKey', 404);
  });
  assert.equal(await s3.getObject('raw-pages', 'aa/gone.html.gz'), null);

  fakeClient(() => {
    throw sdkError('NotFound', 404);
  });
  assert.equal(await s3.getObject('raw-pages', 'aa/gone.html.gz'), null);
});

test('any other failure is rethrown naming the operation, bucket, key and error', async () => {
  const original = sdkError('AccessDenied', 403);
  fakeClient(() => {
    throw original;
  });

  await assert.rejects(
    s3.putObject('raw-pages', 'aa/x.html.gz', new Uint8Array(), { contentType: 'application/gzip' }),
    (error: Error) => {
      assert.match(error.message, /S3 PutObject raw-pages\/aa\/x\.html\.gz failed: AccessDenied/);
      assert.equal(error.cause, original);
      return true;
    },
  );
  await assert.rejects(
    s3.getObject('raw-pages', 'aa/x.html.gz'),
    /S3 GetObject raw-pages\/aa\/x\.html\.gz failed: AccessDenied/,
  );
});

test('ensureBucket creates a missing private bucket and sets no policy', async () => {
  const sent = fakeClient((command) => {
    if (command instanceof HeadBucketCommand) throw sdkError('NotFound', 404);
    return {};
  });

  assert.deepEqual(await s3.ensureBucket('raw-pages', { public: false }), {
    created: true,
    publicPolicy: 'n/a',
  });
  assert.ok(sent[1] instanceof CreateBucketCommand);
  assert.equal(sent[1].input.Bucket, 'raw-pages');
  assert.equal(sent.length, 2);
});

test('ensureBucket leaves an existing private bucket alone', async () => {
  const sent = fakeClient();
  assert.deepEqual(await s3.ensureBucket('raw-pages', { public: false }), {
    created: false,
    publicPolicy: 'n/a',
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof HeadBucketCommand);
});

test('a new public bucket gets a policy allowing anonymous GetObject and nothing else', async () => {
  const sent = fakeClient((command) => {
    if (command instanceof HeadBucketCommand) throw sdkError('NotFound', 404);
    return {};
  });

  assert.deepEqual(await s3.ensureBucket('recipe-images', { public: true }), {
    created: true,
    publicPolicy: 'set',
  });

  const put = sent.find((command) => command instanceof PutBucketPolicyCommand);
  assert.ok(put instanceof PutBucketPolicyCommand);
  const policy = JSON.parse(put.input.Policy!);
  assert.deepEqual(policy.Statement, [
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::recipe-images/*'],
    },
  ]);
});

test('an existing public bucket with the read grant reports ok, in either policy spelling', async () => {
  // The second form is how MinIO stores what `mc anonymous set download` writes.
  for (const statement of [
    { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::recipe-images/*' },
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetBucketLocation', 's3:GetObject'],
      Resource: ['arn:aws:s3:::recipe-images/*'],
    },
  ]) {
    const sent = fakeClient((command) =>
      command instanceof GetBucketPolicyCommand
        ? { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [statement] }) }
        : {},
    );
    assert.deepEqual(await s3.ensureBucket('recipe-images', { public: true }), {
      created: false,
      publicPolicy: 'ok',
    });
    assert.ok(!sent.some((command) => command instanceof PutBucketPolicyCommand));
  }
});

test('an existing public bucket without the grant reports missing and writes nothing', async () => {
  // An operator's own policy is never overwritten; the check only reports.
  const sent = fakeClient((command) => {
    if (command instanceof GetBucketPolicyCommand) throw sdkError('NoSuchBucketPolicy', 404);
    return {};
  });

  assert.deepEqual(await s3.ensureBucket('recipe-images', { public: true }), {
    created: false,
    publicPolicy: 'missing',
  });
  assert.ok(!sent.some((command) => command instanceof PutBucketPolicyCommand));

  fakeClient((command) =>
    command instanceof GetBucketPolicyCommand
      ? {
          Policy: JSON.stringify({
            Statement: [
              { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::other/*' },
            ],
          }),
        }
      : {},
  );
  assert.equal((await s3.ensureBucket('recipe-images', { public: true })).publicPolicy, 'missing');
});

test('without an injected client, missing configuration names every missing variable', () => {
  assert.throws(
    () => s3.s3Client(),
    (error: Error) => {
      assert.match(error.message, /S3_ENDPOINT/);
      assert.match(error.message, /S3_ACCESS_KEY_ID/);
      assert.match(error.message, /S3_SECRET_ACCESS_KEY/);
      assert.match(error.message, /RAW_PAGE_STORE=file/);
      return true;
    },
  );

  process.env.S3_ENDPOINT = 'http://localhost:9000';
  process.env.S3_ACCESS_KEY_ID = 'minio';
  try {
    assert.throws(
      () => s3.s3Client(),
      (error: Error) => {
        assert.doesNotMatch(error.message, /S3_ENDPOINT/);
        assert.match(error.message, /S3_SECRET_ACCESS_KEY/);
        return true;
      },
    );
  } finally {
    process.env.S3_ENDPOINT = '';
    process.env.S3_ACCESS_KEY_ID = '';
  }
});
```

- [ ] **Step 4: Run the tests and check they fail**

Run: `cd backend && npx tsx --test test/s3.test.ts`
Expected: FAIL, because the file can't import `../src/storage/s3.js` (module not found).

- [ ] **Step 5: Write `backend/src/storage/s3.ts`**

```ts
import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../env.js';

/**
 * The one module that talks to object storage.
 *
 * Any S3-compatible store works; locally it is the MinIO service from
 * docker-compose.yml. Path-style addressing (`<endpoint>/<bucket>/<key>`) is
 * forced because MinIO, reached by IP or container name, has no per-bucket
 * hostnames - and it is also the URL shape EXPO_PUBLIC_STORAGE_URL relies on.
 *
 * pages.ts and images.ts own the buckets and the key layout; this module only
 * moves bytes and makes sure a bucket exists.
 */

/** The part of S3Client this module uses, so tests can hand in a fake. */
interface S3Like {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

let client: S3Like | null = null;

/** Test seam: use `fake` instead of a real client, or null to go back. */
export function setS3ClientForTests(fake: S3Like | null): void {
  client = fake;
}

/**
 * The shared client, built on first use. Throws, naming every missing
 * variable, when the store is not configured - so the crawler fails on its
 * first write with something actionable rather than a signing error.
 */
export function s3Client(): S3Like {
  if (client) return client;

  const endpoint = env.s3Endpoint;
  const accessKeyId = env.s3AccessKeyId;
  const secretAccessKey = env.s3SecretAccessKey;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    const missing = [
      !endpoint && 'S3_ENDPOINT',
      !accessKeyId && 'S3_ACCESS_KEY_ID',
      !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
    ].filter(Boolean);
    throw new Error(
      `Object storage is not configured: set ${missing.join(', ')}. ` +
        'For local crawling without an object store, set RAW_PAGE_STORE=file. See backend/.env.example.',
    );
  }

  client = new S3Client({
    endpoint,
    region: env.s3Region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  }) as S3Like;
  return client;
}

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown, ...names: string[]): boolean {
  return status(error) === 404 || names.includes((error as Error)?.name);
}

/** Rethrown with enough context to find the object, keeping the SDK error as `cause`. */
function storageError(operation: string, bucket: string, key: string | null, error: unknown): Error {
  const target = key ? `${bucket}/${key}` : bucket;
  const reason = (error as Error)?.name || String(error);
  return new Error(`S3 ${operation} ${target} failed: ${reason}`, { cause: error });
}

export async function putObject(
  bucket: string,
  key: string,
  body: Uint8Array,
  options: { contentType: string; cacheControl?: string },
): Promise<void> {
  try {
    // Content-addressed keys mean a repeat write is the same bytes, so the
    // plain overwrite S3 does is always safe.
    await s3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
      { abortSignal: AbortSignal.timeout(env.crawlTimeoutMs) },
    );
  } catch (error) {
    throw storageError('PutObject', bucket, key, error);
  }
}

/** The object's bytes, or null when there is no such object. */
export async function getObject(bucket: string, key: string): Promise<Uint8Array | null> {
  try {
    const response = (await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(env.crawlTimeoutMs),
    })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!response.Body) return null;
    return await response.Body.transformToByteArray();
  } catch (error) {
    if (isNotFound(error, 'NoSuchKey', 'NotFound')) return null;
    throw storageError('GetObject', bucket, key, error);
  }
}

export interface BucketReport {
  created: boolean;
  /**
   * For a public bucket: `set` when we just wrote the read policy, `ok` when
   * one is already there, `missing` when an existing bucket lacks it (left
   * alone - an operator's policy is never overwritten). `n/a` when private.
   */
  publicPolicy: 'ok' | 'set' | 'missing' | 'n/a';
}

/** Anonymous read of objects only - no listing, no writes. */
function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** True when `policy` lets anyone GetObject on every key in `bucket`. */
function grantsPublicRead(policy: string, bucket: string): boolean {
  let statements: unknown[];
  try {
    statements = asList((JSON.parse(policy) as { Statement?: unknown }).Statement);
  } catch {
    return false;
  }
  return statements.some((raw) => {
    const statement = raw as { Effect?: string; Principal?: unknown; Action?: unknown; Resource?: unknown };
    const principal = statement.Principal;
    const anyone =
      principal === '*' || asList((principal as { AWS?: unknown } | undefined)?.AWS).includes('*');
    return (
      statement.Effect === 'Allow' &&
      anyone &&
      asList(statement.Action).some((action) => action === 's3:GetObject' || action === 's3:*') &&
      asList(statement.Resource).includes(`arn:aws:s3:::${bucket}/*`)
    );
  });
}

/** Create the bucket if it is missing; for a public one, make sure anyone can read it. */
export async function ensureBucket(bucket: string, options: { public: boolean }): Promise<BucketReport> {
  const s3 = s3Client();

  let created = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isNotFound(error, 'NotFound', 'NoSuchBucket')) throw storageError('HeadBucket', bucket, null, error);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (createError) {
      throw storageError('CreateBucket', bucket, null, createError);
    }
    created = true;
  }

  if (!options.public) return { created, publicPolicy: 'n/a' };

  if (created) {
    try {
      await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
    } catch (error) {
      throw storageError('PutBucketPolicy', bucket, null, error);
    }
    return { created, publicPolicy: 'set' };
  }

  try {
    const { Policy } = (await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))) as { Policy?: string };
    return { created, publicPolicy: Policy && grantsPublicRead(Policy, bucket) ? 'ok' : 'missing' };
  } catch (error) {
    if (isNotFound(error, 'NoSuchBucketPolicy')) return { created, publicPolicy: 'missing' };
    throw storageError('GetBucketPolicy', bucket, null, error);
  }
}
```

- [ ] **Step 6: Run the tests and check they pass**

Run: `cd backend && npx tsx --test test/s3.test.ts`
Expected: `ℹ pass 11`, `ℹ fail 0`.

- [ ] **Step 7: Commit** (don't typecheck yet: `pages.ts` and `images.ts` still reference the removed env fields until Tasks 2 and 3)

```bash
git add backend/package.json backend/package-lock.json backend/src/env.ts backend/src/storage/s3.ts backend/test/s3.test.ts
git commit -m "Add an S3 storage client and the S3_* settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Raw pages on S3

**Files:**
- Modify: `backend/src/storage/pages.ts` (replace the whole "Supabase Storage" section, `ensureBucket`, the file-driver comment and `pageStore`)
- Test: `backend/test/storage.test.ts`

**Interfaces:**
- Consumes (Task 1): `putObject`, `getObject`, `ensureBucket as ensureS3Bucket`, `s3Client`, `setS3ClientForTests`, and `env.rawPageStore` (a getter).
- Produces, unchanged signatures: `pathForContent`, `ensureBucket(): Promise<string>`, `resetPageStore()`, `describeStore(): string`, `writePage(contentHash, html): Promise<string>`, `readPage(objectPath): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests.** In `backend/test/storage.test.ts`:

(a) Replace the comment and declarations at the top:

```ts
// `env` reads these once, at module load, so they are set before the store is
// imported. The filesystem driver is what keeps this suite free of a Supabase
// project - the deployed crawler uses Supabase Storage.
let dir: string;
let store: typeof import('../src/storage/pages.js');
```

with:

```ts
// Set before the store is imported. The filesystem driver keeps most of this
// suite free of an object store; the s3 driver is exercised through a fake
// client at the end.
let dir: string;
let store: typeof import('../src/storage/pages.js');
let s3: typeof import('../src/storage/s3.js');
let env: typeof import('../src/env.js').env;
```

(b) In `before`, after `store = await import('../src/storage/pages.js');`, add:

```ts
  s3 = await import('../src/storage/s3.js');
  env = (await import('../src/env.js')).env;
```

(c) Add `import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';` after the `node:zlib` import.

(d) Append:

```ts
/** Swap to the s3 driver backed by an in-memory fake; returns the fake's objects. */
function useFakeS3(): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  s3.setS3ClientForTests({
    async send(command: unknown) {
      const { Bucket, Key, Body } = (command as { input: { Bucket: string; Key: string; Body?: Uint8Array } })
        .input;
      if (command instanceof PutObjectCommand) {
        objects.set(`${Bucket}/${Key}`, Body!);
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const bytes = objects.get(`${Bucket}/${Key}`);
        if (!bytes) {
          throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      throw new Error(`unexpected command ${String(command)}`);
    },
  });
  process.env.RAW_PAGE_STORE = '';
  store.resetPageStore();
  return objects;
}

function useFileStore(): void {
  s3.setS3ClientForTests(null);
  process.env.RAW_PAGE_STORE = 'file';
  store.resetPageStore();
}

test('with RAW_PAGE_STORE unset, pages go to the raw-page bucket, gzipped', async () => {
  const objects = useFakeS3();
  try {
    const html = '<html><body>bún chả</body></html>';
    const objectPath = await store.writePage('d'.repeat(64), html);

    const stored = objects.get(`${env.rawPageBucket}/${objectPath}`);
    assert.ok(stored, 'object written to the raw-page bucket');
    assert.equal(gunzipSync(stored).toString('utf8'), html);
    assert.equal(await store.readPage(objectPath), html);
    assert.equal(await store.readPage('ff/missing.html.gz'), null);
  } finally {
    useFileStore();
  }
});

test('a leftover RAW_PAGE_STORE value from before MinIO is rejected, not guessed at', () => {
  process.env.RAW_PAGE_STORE = 'supabase';
  store.resetPageStore();
  try {
    assert.throws(() => store.describeStore(), /RAW_PAGE_STORE="supabase".*s3.*file/);
  } finally {
    useFileStore();
  }
});
```

- [ ] **Step 2: Run the tests and check the new ones fail**

Run: `cd backend && npx tsx --test test/storage.test.ts`
Expected: the 5 existing tests pass, and the 2 new ones fail. The first fails on the Supabase configuration error. The second fails because nothing throws for `supabase`.

- [ ] **Step 3: Rewrite `backend/src/storage/pages.ts`.** Keep the imports, `log`, `pathForContent` and `interface PageStore` as they are. Add this import:

```ts
import { ensureBucket as ensureS3Bucket, getObject, putObject, s3Client } from './s3.js';
```

Replace everything from `// --- Supabase Storage ---` through the end of the `ensureBucket` function with:

```ts
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
```

Replace the file driver's doc comment with:

```ts
/**
 * For local work and for tests, which must not need an object store to run.
 * Not a second production target: deployments use the s3 driver.
 */
```

Replace the `pageStore` function with:

```ts
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
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `cd backend && npx tsx --test test/storage.test.ts test/s3.test.ts`
Expected: `ℹ fail 0` (18 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/storage/pages.ts backend/test/storage.test.ts
git commit -m "Store raw pages in S3 instead of Supabase Storage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Recipe images on S3, and the CLI checks

**Files:**
- Modify: `backend/src/storage/images.ts` (the header comment and everything from `function config()` to the end of the file)
- Modify: `backend/src/cli.ts` (the `setup` case, around lines 105–118)
- Test: `backend/test/images.test.ts`

**Interfaces:**
- Consumes (Task 1): `putObject`, `ensureBucket as ensureS3Bucket`, `setS3ClientForTests`, `env.s3PublicUrl`.
- Produces, unchanged signatures: `isSupportedImageType`, `pathForImage`, `publicBaseUrl(): string`, `publicUrlFor(path): string`, `ensureImageBucket(): Promise<string>`, `storeImage(bytes, contentType): Promise<string>`.

- [ ] **Step 1: Write the failing tests.** In `backend/test/images.test.ts`:

(a) Change the imports to:

```ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { isSupportedImageType, pathForImage, publicBaseUrl, storeImage } from '../src/storage/images.js';
import { setS3ClientForTests } from '../src/storage/s3.js';
import { normalizeImages } from '../src/crawl/images.js';
```

(b) Append:

```ts
afterEach(() => {
  setS3ClientForTests(null);
});

test('a stored image goes to the image bucket with its real type and a long cache lifetime', async () => {
  const sent: unknown[] = [];
  setS3ClientForTests({
    async send(command: unknown) {
      sent.push(command);
      return {};
    },
  });

  const objectPath = await storeImage(BYTES, 'IMAGE/PNG; charset=binary');

  assert.equal(objectPath, pathForImage(BYTES, 'image/png'));
  const command = sent[0];
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, env.recipeImageBucket);
  assert.equal(command.input.Key, objectPath);
  assert.equal(command.input.ContentType, 'image/png');
  assert.equal(command.input.CacheControl, 'public, max-age=31536000, immutable');
});

test('the public base URL uses S3_PUBLIC_URL, else S3_ENDPOINT, without doubled slashes', () => {
  const saved = { public: process.env.S3_PUBLIC_URL, endpoint: process.env.S3_ENDPOINT };
  try {
    process.env.S3_ENDPOINT = 'http://minio:9000/';
    process.env.S3_PUBLIC_URL = 'http://192.168.1.20:9000/';
    assert.equal(publicBaseUrl(), `http://192.168.1.20:9000/${env.recipeImageBucket}`);

    process.env.S3_PUBLIC_URL = '';
    assert.equal(publicBaseUrl(), `http://minio:9000/${env.recipeImageBucket}`);

    process.env.S3_ENDPOINT = '';
    assert.throws(() => publicBaseUrl(), /S3_PUBLIC_URL.*S3_ENDPOINT/);
  } finally {
    process.env.S3_PUBLIC_URL = saved.public ?? '';
    process.env.S3_ENDPOINT = saved.endpoint ?? '';
  }
});
```

- [ ] **Step 2: Run the tests and check the new ones fail**

Run: `cd backend && npx tsx --test test/images.test.ts`
Expected: both new tests fail, because `config()` throws "Image storage is not configured: set SUPABASE_URL…" (or, under typecheck, because `env.supabaseUrl` no longer exists).

- [ ] **Step 3: Rewrite `backend/src/storage/images.ts`.** Add this import:

```ts
import { ensureBucket as ensureS3Bucket, putObject } from './s3.js';
```

In the header comment, change `serve from the same project as everything else.` to `serve from storage we run ourselves.` Change the `EXTENSION_BY_TYPE` doc comment to `/** What we store, and the app will render. */`. Then replace everything from `function config()` to the end of the file with:

```ts
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
```

- [ ] **Step 4: Make `setup` ensure both buckets.** In `backend/src/cli.ts`, replace:

```ts
      // Crawling writes its first page to object storage, so the bucket being
      // absent should surface here and not on the first fetch. A project
      // without storage credentials yet is a warning, not a failed setup.
      try {
        log.info(await ensureBucket());
      } catch (error) {
        log.warn(`page storage not ready: ${String(error)}`);
      }
```

with:

```ts
      // Crawling writes its first page to object storage, so a missing bucket
      // should surface here and not on the first fetch. A machine without
      // storage credentials yet is a warning, not a failed setup.
      try {
        log.info(await ensureBucket());
      } catch (error) {
        log.warn(`page storage not ready: ${String(error)}`);
      }
      try {
        log.info(await ensureImageBucket());
      } catch (error) {
        log.warn(`image storage not ready: ${String(error)}`);
      }
```

The `images --check` branch needs no change: it already logs `ensureImageBucket()` and `publicBaseUrl()`.

- [ ] **Step 5: Run the full backend suite and typecheck**

Run: `cd backend && npm run typecheck && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"`
Expected: typecheck exits 0 (no reference to `supabaseUrl` or `supabaseServiceRoleKey` is left), and the tests show `ℹ fail 0`.

Also run: `cd backend && grep -rn "SUPABASE\|supabaseUrl\|storage/v1" src/ | grep -v "src/db.ts"`
Expected: no output.

- [ ] **Step 6: Manual check that an unconfigured store fails clearly.** This checks Review Focus item 5.

Run: `cd backend && S3_ENDPOINT= S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY= RAW_PAGE_STORE=s3 npm run dev -- storage check`
Expected: the command exits non-zero with `Object storage is not configured: set S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY. For local crawling without an object store, set RAW_PAGE_STORE=file.` Empty inline values win over `.env` because dotenv doesn't override existing keys. Don't run `setup`: it migrates the user's database.

- [ ] **Step 7: Commit**

```bash
git add backend/src/storage/images.ts backend/src/cli.ts backend/test/images.test.ts
git commit -m "Mirror recipe images into S3 and ensure both buckets in setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: MinIO in docker compose, env templates, and the live integration test

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/.env.example`, root `.env.example` (may be permission-denied; see Step 3)
- Create: `backend/test/s3.integration.test.ts`

**Interfaces:**
- Consumes (Task 1): `ensureBucket`, `putObject`, `getObject`, `s3Client`; `env.s3Endpoint`, `env.s3AccessKeyId`, `env.s3SecretAccessKey`, `env.s3PublicUrl`, `env.rawPageBucket`, `env.recipeImageBucket`.
- Produces: the `minio` compose service on ports 9000/9001, and the named volume `minio-data`.

- [ ] **Step 1: Write the integration test** `backend/test/s3.integration.test.ts`

```ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { ensureBucket, getObject, putObject, s3Client } from '../src/storage/s3.js';

/**
 * Runs against a real MinIO (docker compose up -d minio) when one is
 * configured and answering, and skips otherwise - the same pattern as the
 * database tests, so `npm test` stays green in CI with no object store.
 * It uses the real buckets, so it also checks what the app depends on: that
 * the image bucket is readable without credentials.
 */
async function skipReason(): Promise<string | false> {
  if (!env.s3Endpoint || !env.s3AccessKeyId || !env.s3SecretAccessKey) return 'S3_* not set';
  try {
    await fetch(env.s3Endpoint, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return `no object store answering at ${env.s3Endpoint}`;
  }
}

const skip = await skipReason();

test('an object round-trips through the private bucket', { skip }, async () => {
  const bucket = env.rawPageBucket;
  const key = `integration-test/${randomUUID()}.bin`;
  const body = new Uint8Array([1, 2, 3, 4]);

  await ensureBucket(bucket, { public: false });
  try {
    await putObject(bucket, key, body, { contentType: 'application/octet-stream' });
    assert.deepEqual(await getObject(bucket, key), body);
  } finally {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  assert.equal(await getObject(bucket, key), null);
});

test('an object in the image bucket is readable anonymously at the public URL', { skip }, async () => {
  const bucket = env.recipeImageBucket;
  const key = `integration-test/${randomUUID()}.png`;

  const report = await ensureBucket(bucket, { public: true });
  assert.notEqual(report.publicPolicy, 'missing', `bucket "${bucket}" has no anonymous read policy`);
  try {
    await putObject(bucket, key, new Uint8Array([137, 80, 78, 71]), { contentType: 'image/png' });
    const response = await fetch(`${env.s3PublicUrl}/${bucket}/${key}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
});
```

- [ ] **Step 2: Add MinIO to `docker-compose.yml`.**

(a) Replace the header's usage block (from `# Usage:` down to `#   docker compose up --build`) with:

```yaml
# Usage:
#   cp .env.example .env                   # MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
#                                           # (compose reads the root .env)
#   cp backend/.env.example backend/.env   # fill in DATABASE_URL, provider keys,
#                                           # S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY
#                                           # (the MinIO credentials), S3_PUBLIC_URL,
#                                           # REVIEW_USERNAME/PASSWORD,
#                                           # CLERK_ISSUER, CLERK_AUTHORIZED_PARTIES,
#                                           # LIVEKIT_URL/_API_KEY/_API_SECRET (voice tokens)
#   cp agent/.env.example agent/.env       # fill in LIVEKIT_*
#   docker compose up --build
```

(b) Under `services:`, add before `api:`:

```yaml
  # Object storage for crawled pages and recipe images (S3 API on 9000, web
  # console on 9001). The backend creates its buckets itself: run
  # `npm run dev -- storage check` and `npm run dev -- images --check`.
  minio:
    image: minio/minio
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:?set MINIO_ROOT_USER in the root .env}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD in the root .env}
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data
    restart: unless-stopped

```

(c) In the `api` service, after `env_file: ./backend/.env`, add:

```yaml
    environment:
      # localhost inside a container is the container itself. S3_PUBLIC_URL
      # is not overridden: it has to be an address the phone can reach.
      S3_ENDPOINT: http://minio:9000
    depends_on:
      - minio
```

(d) In the `crawler` service, add `S3_ENDPOINT: http://minio:9000` to its existing `environment:` map, below `REVIEW_HOST: "0.0.0.0"`, and add after the `environment` block:

```yaml
    depends_on:
      - minio
```

(e) At the end of the file, add a top-level:

```yaml

volumes:
  minio-data:
```

Run: `cd /Users/kpmquockhanh/code/cook-mate-rn && MINIO_ROOT_USER=x MINIO_ROOT_PASSWORD=y docker compose config --quiet`
Expected: exit 0. If `docker` isn't installed, say so in the report and move on.

- [ ] **Step 3: Update the env templates.** If a permission prompt denies either edit, don't retry and don't work around it. List the exact text below in your report as a user action.

In `backend/.env.example`, delete the `SUPABASE_URL=` and `SUPABASE_SERVICE_ROLE_KEY=` lines and their comments. Change any `RAW_PAGE_STORE` comment that mentions `supabase` so it says the values are `s3` (default) or `file`. Add:

```bash
# Object storage (MinIO from docker-compose.yml, or any S3-compatible store).
# Locally the keys are the MinIO root user/password from the root .env.
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
# S3_REGION=us-east-1
# Where the app reads public images. Set it to this machine's LAN address
# (e.g. http://192.168.1.20:9000) to test on a phone. Defaults to S3_ENDPOINT.
# S3_PUBLIC_URL=
```

In the root `.env.example`, add:

```bash
# MinIO root credentials for `docker compose up minio` (compose reads this
# file). Not used by the app itself. Use the same values for the backend's
# S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY locally.
MINIO_ROOT_USER=cookmate
MINIO_ROOT_PASSWORD=change-me-minio
```

Also update the comment on `EXPO_PUBLIC_STORAGE_URL` in the root `.env.example` (if it has one) to: `# Public image bucket, as printed by \`cd backend && npm run dev -- images --check\` (e.g. http://192.168.1.20:9000/recipe-images).`

Run: `cd /Users/kpmquockhanh/code/cook-mate-rn && npm run env:check`
Expected: no `err` line mentioning `S3_`. Other pre-existing warnings are fine. If the `.env.example` edits were denied, expect errors for the `S3_*` variables and note them as the user action.

- [ ] **Step 4: Run the backend suite**

Run: `cd backend && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"`
Expected: `ℹ fail 0`. The two integration tests are skipped unless a configured MinIO is running.

- [ ] **Step 5: Commit** (add the `.env.example` files only if you actually edited them)

```bash
git add docker-compose.yml backend/test/s3.integration.test.ts backend/.env.example .env.example
git commit -m "Run MinIO in docker compose and document the S3 settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and Supabase leftovers

**Files:**
- Modify: `backend/README.md` (around lines 62–81, 268–273, 347–348 and 383)
- Modify: `.github/workflows/ci.yml` (comment around line 34)
- Delete: `supabase/config.toml`
- Modify: `.gitignore` (the "Supabase CLI local state" block, around lines 80–81)
- Modify, **not committed**: `README.md` (lines 17 and 150–152), `backend/CLAUDE.md` (line 58)

**Interfaces:** none (docs only).

- [ ] **Step 1: `backend/README.md`, "Where crawled HTML lives".** Replace the paragraph starting `Pages are kept in object storage (Supabase Storage)` with:

```markdown
Pages are kept in object storage (MinIO locally, over the S3 API), not in a
Postgres column. `raw_pages` holds the reference and the content hash. They are
**content-addressed and gzipped**, so the same HTML reached by two URLs is
stored once and re-storing an unchanged page overwrites itself.
```

Replace the paragraph starting `Set \`SUPABASE_SERVICE_ROLE_KEY\` for this` with:

```markdown
Storage is configured with `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` (plus optional `S3_REGION`, default `us-east-1`).
`S3_PUBLIC_URL` is where clients read public images: set it to this machine's
LAN address (e.g. `http://192.168.1.20:9000`) to test on a phone. It defaults
to `S3_ENDPOINT`. Under docker compose the containers reach MinIO at
`http://minio:9000`, so set `S3_PUBLIC_URL` there too. For local work with no
object store, set `RAW_PAGE_STORE=file` and pages go to `RAW_PAGE_DIR` on disk
instead.

Start MinIO with `docker compose up -d minio` from the repo root, after setting
`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in the root `.env`. Its console is on
http://localhost:9001. The root credentials are fine for local work. Elsewhere,
create an access key limited to the two buckets, and put MinIO behind TLS with
`S3_PUBLIC_URL` set to its public address.

**Moving from Supabase Storage** (a fresh start, nothing is copied):

1. Start MinIO as above and set the `S3_*` values in `backend/.env`. Delete
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
2. `npm run dev -- storage check && npm run dev -- images --check` creates both
   buckets, and the second command prints the value for the app's
   `EXPO_PUBLIC_STORAGE_URL`.
3. Put that value in the root `.env` and restart the Expo dev server.
4. `npm run dev -- images --force`, then `npm run publish`, so every recipe
   points at re-mirrored images.
5. Raw pages need nothing: a missing object is re-fetched when the crawler
   next needs it.
```

- [ ] **Step 2: Other lines in `backend/README.md`.**
  - In the Docker section's code block, change `# LIVEKIT_*, SUPABASE_URL (storage), REVIEW_USERNAME/REVIEW_PASSWORD` to `# LIVEKIT_*, S3_* (MinIO), REVIEW_USERNAME/REVIEW_PASSWORD`. Directly below the block, add `The compose file also starts MinIO; its credentials come from the root \`.env\`.`
  - Delete the paragraph `` `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used for object storage only (raw pages and recipe images); they play no part in authentication. ``
  - In the stages table, change `into our own **public** Supabase bucket` to `into our own **public** bucket`.
  - Leave line ~103 ("If you are pointing at a Supabase project that already had the app tables") alone: it's about Postgres.

Run: `grep -n -i "supabase" backend/README.md`
Expected: only the Postgres-related line (~103) remains.

- [ ] **Step 3: CI comment.** In `.github/workflows/ci.yml`, change:

```yaml
      # The suite is deliberately runnable with no Supabase project and no
      # DATABASE_URL: raw-page storage falls back to the filesystem store.
```

to:

```yaml
      # The suite is deliberately runnable with no object store and no
      # DATABASE_URL: storage tests use the filesystem driver or a fake S3
      # client, and the live MinIO/DB tests skip themselves.
```

- [ ] **Step 4: Remove the Supabase CLI config.**

Run: `cd /Users/kpmquockhanh/code/cook-mate-rn && git rm supabase/config.toml`

In `.gitignore`, delete these two lines and the blank line after them:

```
## Supabase CLI local state
supabase/.temp/
```

Run: `grep -rn "supabase/config.toml\|supabase/.temp" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude --exclude-dir=docs . || true`
Expected: no output.

- [ ] **Step 5: Update, but do not commit, the user's files.**
  - `README.md` line 17: `Fastify API + Postgres; Supabase Storage for images` becomes `Fastify API + Postgres; MinIO (S3) for images`.
  - `README.md`, Docker block: change `# SUPABASE_URL (storage),` to `# S3_* (MinIO; credentials in the root .env),`.
  - `backend/CLAUDE.md`: change the sentence fragment `` `SUPABASE_*` is storage-only. `` to `Object storage is S3/MinIO via \`src/storage/s3.ts\` (\`S3_*\`).`

- [ ] **Step 6: Final verification**

Run: `cd backend && npm run typecheck && npm test 2>&1 | grep -E "^ℹ (pass|fail|skipped)"`
Expected: typecheck exit 0, `ℹ fail 0`.

Run: `cd /Users/kpmquockhanh/code/cook-mate-rn && npm test 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `ℹ fail 0` (the app is unchanged; this confirms it).

Run: `git status --short`
Expected: `README.md`, `app.json`, `CLAUDE.md` and `backend/CLAUDE.md` are still modified or untracked, and nothing else is.

- [ ] **Step 7: Commit** (explicit paths only; not `README.md` or `backend/CLAUDE.md`)

```bash
git add backend/README.md .github/workflows/ci.yml .gitignore
git commit -m "Document MinIO storage and drop the Supabase CLI config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git rm` in Step 4 already staged the deletion of `supabase/config.toml`, so it's included in this commit.)
