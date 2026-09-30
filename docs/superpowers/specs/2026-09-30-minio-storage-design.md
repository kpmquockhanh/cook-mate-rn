# Replace Supabase Storage with self-hosted MinIO — design

Date: 2026-09-30
Status: approved in brainstorming, pending spec review

## Context and goal

The backend pipeline keeps two kinds of objects in Supabase Storage, through its
REST API (`/storage/v1/...`) with the service-role key:

- **Raw pages**: gzipped crawled HTML at `ab/<sha256>.html.gz` in the private
  bucket `raw-pages` (`backend/src/storage/pages.ts`). `raw_pages.storage_path`
  holds the key.
- **Recipe images**: mirrored images at `ab/<sha256>.<ext>` in the public bucket
  `recipe-images` (`backend/src/storage/images.ts`), uploaded with
  `cache-control: public, max-age=31536000, immutable`. `recipe_staging.image_paths`
  holds the keys, and publish copies them into `public.recipes`.

The app never talks to storage with credentials. It builds image URLs as
`EXPO_PUBLIC_STORAGE_URL + '/' + path` and loads them with a plain `<Image>`.
`lib/connectivity.ts` also probes `env.storageUrl` as a fallback, where any HTTP
answer counts as reachable.

This is **sub-project 2 of 3** in removing Supabase:

1. Clerk auth, with `livekit-token` moved into the API (done, merged to main).
2. **Storage moves to self-hosted MinIO over the S3 API** (this spec).
3. Postgres moves to self-hosted Postgres (later).

After this one, the backend's only link to Supabase is the Postgres connection.

### Decisions

| Topic | Decision |
|---|---|
| Existing objects | Fresh start. Nothing is copied from Supabase. Images are re-mirrored; raw pages re-fetch when the crawler next needs them. |
| Where MinIO runs | A `minio` service in the root `docker-compose.yml` for local development. Production hosting is decided later. |
| Client library | `@aws-sdk/client-s3` in `backend/`. No MinIO-specific SDK, so any S3-compatible store works later. |
| Bucket setup | Done in code by the backend (`ensureBucket`) from `setup`, `storage check` and `images --check`. There is no `mc` init container. |
| Image URLs | `EXPO_PUBLIC_STORAGE_URL = ${S3_PUBLIC_URL}/recipe-images`. MinIO serves the public bucket through path-style URLs and an anonymous read policy. |
| Object keys | Unchanged: the same content-addressed keys, so no DB column changes and no migration. |

### Success criteria

- `docker compose up -d minio` followed by `npm run dev -- storage check` and
  `npm run dev -- images --check` creates both buckets and reports them healthy,
  and `images --check` prints the exact `EXPO_PUBLIC_STORAGE_URL` value to use.
- The pipeline crawls, stores and re-reads raw pages in MinIO. `images --force`
  followed by a republish makes the recipe images load in the app on iOS, Android
  and web.
- No code in `backend/` references `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or
  `/storage/v1`.
- `cd backend && npm test` passes without a running MinIO or any network access.

## Architecture

### Components

**`minio` service (`docker-compose.yml`)**

- Image `minio/minio`, command `server /data --console-address :9001`.
- Ports `9000` (S3 API) and `9001` (web console), and a named volume `minio-data`
  for `/data`.
- Root credentials come from `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in a root
  `.env` (compose reads it automatically), documented in a root `.env.example`.
- `api` and `crawler` get `depends_on: [minio]` and an `environment` override of
  `S3_ENDPOINT: http://minio:9000`, because `localhost` inside a container is the
  container itself. `S3_PUBLIC_URL` is not overridden: it must stay an address the
  phone can reach.
- CORS needs no setup. MinIO sets CORS server-wide through
  `MINIO_API_CORS_ALLOW_ORIGIN`, which defaults to `*`, so the web build's
  connectivity probe works. Web `<Image>` loads don't need CORS anyway.

**Backend environment (`backend/src/env.ts`)**

| Variable | Default | Purpose |
|---|---|---|
| `S3_ENDPOINT` | none (required for the s3 driver) | S3 API base the backend talks to. Dev: `http://localhost:9000`. |
| `S3_REGION` | `us-east-1` | Signing region. MinIO accepts anything, but the SDK needs one. |
| `S3_ACCESS_KEY_ID` | none (required) | Access key. Dev: the MinIO root user. |
| `S3_SECRET_ACCESS_KEY` | none (required) | Secret key. Dev: the MinIO root password. |
| `S3_PUBLIC_URL` | `S3_ENDPOINT` | Base clients use to read public objects, for example `http://192.168.1.20:9000` so a phone on the LAN can reach it. Trailing slashes are trimmed. |
| `RAW_PAGE_STORE` | `s3` | `s3` or `file`. The old value `supabase` is gone. |

`RAW_PAGE_BUCKET` (`raw-pages`), `RAW_PAGE_DIR`, `RECIPE_IMAGE_BUCKET`
(`recipe-images`), `IMAGE_MAX_BYTES` and `IMAGES_PER_RECIPE` keep their names and
defaults. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are removed from `env.ts`
and from `backend/.env.example`.

**New module: `backend/src/storage/s3.ts`**

This is the only file that imports `@aws-sdk/client-s3`.

- `s3Client()` builds a lazy, memoised `S3Client` with `endpoint`, `region`,
  credentials and `forcePathStyle: true`. If `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` or
  `S3_SECRET_ACCESS_KEY` is missing, it throws one error that names all the missing
  variables and mentions `RAW_PAGE_STORE=file` as the no-storage option for
  local crawling.
- `putObject(bucket, key, body, { contentType, cacheControl? })` has no return
  value. It passes `abortSignal: AbortSignal.timeout(env.crawlTimeoutMs)`.
- `getObject(bucket, key)` returns `Uint8Array | null`. `NoSuchKey`, or a 404 status
  in the error metadata, becomes `null`.
- `ensureBucket(bucket, { public: boolean })` returns a report
  `{ created: boolean; publicPolicy: 'ok' | 'set' | 'missing' | 'n/a' }`.
  - It calls `HeadBucket`, and on a 404 it calls `CreateBucket`.
  - For `public: true` it reads the bucket policy. When the bucket was just
    created, it writes a policy granting only `s3:GetObject` to `*` on
    `arn:aws:s3:::<bucket>/*`. On an existing bucket without that grant it
    reports `missing` and leaves the policy alone, so an operator's policy is
    never overwritten.
- Any other SDK error is rethrown as an `Error` whose message names the operation,
  bucket, key and SDK error name (for example
  `S3 PutObject raw-pages/ab/…html.gz failed: AccessDenied`), with the original as
  `cause`.
- Test seam: `setS3ClientForTests(client | null)`, in the same style as
  `resetPageStore()`. The fake only needs a `send(command)` method.

**`backend/src/storage/pages.ts`**

- `supabaseStore()` is replaced by `s3Store()`, which calls `putObject`/`getObject`
  on `env.rawPageBucket` with content type `application/gzip`.
- `pageStore()` picks `env.rawPageStore === 'file' ? fileStore() : s3Store()`.
- `ensureBucket()` (the raw-page one used by `setup` and `storage check`) delegates
  to `s3.ensureBucket(env.rawPageBucket, { public: false })`. It stays a no-op for
  the file driver.
- `describe()` returns `s3 <endpoint> bucket "<bucket>"`.
- `pathForContent`, `writePage`, `readPage`, `resetPageStore` and the file driver are
  unchanged.

**`backend/src/storage/images.ts`**

- `config()` goes away. `storeImage(bytes, contentType)` computes the key with
  `pathForImage` as before, then calls `putObject` on `env.recipeImageBucket` with
  the normalised content type and the same immutable `cache-control`.
- `ensureImageBucket()` delegates to `s3.ensureBucket(env.recipeImageBucket, { public: true })`
  and keeps its existing role of reporting a bucket that is not publicly readable.
  The bucket-level `file_size_limit` and allowed MIME types are dropped: MinIO has no
  equivalent, and `images/run.ts` already enforces `IMAGE_MAX_BYTES` and
  `isSupportedImageType` before upload.
- `publicBaseUrl()` returns `${S3_PUBLIC_URL}/${bucket}`. `publicUrlFor(path)` builds
  on it as before.

**`backend/src/cli.ts`**

- Imports and command names are unchanged.
- `images --check` prints the `publicPolicy` report, and the existing line
  `app must point EXPO_PUBLIC_STORAGE_URL at ${publicBaseUrl()}` now prints the
  MinIO URL.
- `setup` ensures both buckets, and a failure is a warning, as it is today for the
  raw-page bucket.

**App**

No code change. `EXPO_PUBLIC_STORAGE_URL` gets a new value; nothing in `lib/`
names Supabase Storage.

### Data flow

Only the transport changes:

- **Crawl:** `writePage` gzips the HTML and does an s3 `putObject` into
  `raw-pages/ab/<sha>.html.gz`, and `raw_pages.storage_path` stores the key.
- **Re-read:** `readPage` does a `getObject`. A missing object returns `null` and
  logs a warning, and the crawler re-fetches the page, as it does today.
- **Images stage:** `mirrorImages` downloads, validates the type and size, calls
  `storeImage` to `putObject` into `recipe-images/ab/<sha>.<ext>`, and writes the key
  to `recipe_staging.image_paths`.
- **Publish:** copies the keys into `public.recipes`. This is unchanged.
- **App:** reads the image at `${EXPO_PUBLIC_STORAGE_URL}/${path}`, which is
  `${S3_PUBLIC_URL}/recipe-images/ab/<sha>.<ext>` served anonymously by MinIO.

### Cutover runbook (goes into `backend/README.md`)

1. Set `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in the root `.env`, then run
   `docker compose up -d minio`.
2. In `backend/.env`, set the `S3_*` variables (with `S3_PUBLIC_URL` set to the
   machine's LAN IP when testing on a phone) and delete the two `SUPABASE_*`
   storage lines.
3. `cd backend && npm run dev -- storage check && npm run dev -- images --check`.
   Both buckets are created, and the second command prints the
   `EXPO_PUBLIC_STORAGE_URL` value.
4. Put that value in the root `.env` and restart the Expo dev server.
5. `npm run dev -- images --force`, then republish (`npm run publish`) so every
   recipe points at re-mirrored images.
6. Raw pages need no action: missing objects are re-fetched as the crawler needs
   them.

## Error handling

| Situation | Behaviour |
|---|---|
| `S3_*` not set, s3 driver selected | One error listing the missing variables and suggesting `RAW_PAGE_STORE=file`. `setup` downgrades it to a warning. |
| Object missing on read (`NoSuchKey`/404) | `getObject` returns `null`, `readPage` warns and returns `null`, and the crawler re-fetches. |
| MinIO unreachable, bad credentials, other SDK error | Rethrown with operation, bucket, key and SDK error name. The stage's existing per-item error handling applies (the item fails and the run continues). |
| Slow upload | Aborted after `CRAWL_TIMEOUT_MS` by `AbortSignal.timeout`. |
| Public bucket has no anonymous read policy | `images --check` reports `missing` and says how to fix it. The policy is only written automatically on a bucket the backend just created. |
| App probing storage | MinIO answers an anonymous GET on `S3_PUBLIC_URL` with an HTTP status (403), which counts as reachable. No change needed. |

## Testing

All standard tests use `node:test` via `tsx --test` and need no MinIO or network.

- **`backend/test/s3.test.ts`**, with the fake client injected through
  `setS3ClientForTests`:
  - `putObject` sends the bucket, key, body, content type and cache control.
  - `getObject` returns the bytes. It returns `null` on `NoSuchKey` and on a 404,
    and it rethrows other errors with the operation, bucket, key and error name in
    the message.
  - `ensureBucket` creates a missing bucket and leaves an existing one alone.
  - With `public: true` on a new bucket, it writes a policy granting only
    `s3:GetObject` on `arn:aws:s3:::<bucket>/*`.
  - On an existing public bucket without the grant, it reports `missing` and writes
    nothing.
  - The not-configured error names every missing `S3_*` variable.
- **`backend/test/storage.test.ts`:**
  - The existing file-driver tests stay as they are.
  - New: `RAW_PAGE_STORE` unset selects the s3 driver.
  - New: `writePage`/`readPage` round-trip gzip through the fake client.
- **Images tests:**
  - `storeImage` uploads with the normalised content type and the immutable
    `cache-control`.
  - `publicBaseUrl()` uses `S3_PUBLIC_URL` when set and falls back to
    `S3_ENDPOINT`, with trailing slashes trimmed.
- **Optional integration test (`backend/test/s3.integration.test.ts`):**
  - It skips itself unless `S3_ENDPOINT` answers, in the same way the DB tests skip
    themselves.
  - It puts, gets and deletes one object in real MinIO, and checks that an
    anonymous `fetch` of an object in the public bucket returns 200.
- **`npm run env:check`** stays green once the new variables are in
  `backend/.env.example` and the root `.env.example` gains
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. If editing `.env.example` files is
  denied by permissions, those edits are handed to the user as action items.

## Documentation

- `backend/README.md`: rewrite the storage sections (Supabase Storage becomes
  MinIO/S3), the environment reference, the docker compose notes, and add the
  cutover runbook above.
- `docker-compose.yml` header comment: replace `SUPABASE_URL` with the `S3_*`
  variables and mention the root `.env` for the MinIO credentials.
- Comments that say "Supabase Storage" in `backend/src/env.ts` (the storage block
  only; the pooler note is Postgres and stays), `backend/src/storage/*.ts` and
  `backend/test/storage.test.ts`.
- Root `README.md`, `CLAUDE.md` and `backend/CLAUDE.md`: storage mentions are
  updated but left uncommitted, because those files carry the user's own
  uncommitted edits.
- `supabase/config.toml` is deleted. Storage was the last thing the local Supabase
  CLI config served, and nothing in the repo reads it. The `supabase/.temp/` line
  in `.gitignore` goes with it.

## Out of scope

- Postgres. That is sub-project 3, and the Supabase TLS notes in
  `backend/src/db.ts` stay until then.
- Production MinIO hosting, TLS and a reverse proxy. The README only says to put
  MinIO behind TLS and set `S3_PUBLIC_URL` to its public address.
- Dedicated least-privilege MinIO access keys. The README recommends one scoped to
  the two buckets, but the root credentials are acceptable for local development.
- Copying existing objects out of Supabase.
- Image resizing, thumbnails or a CDN.
