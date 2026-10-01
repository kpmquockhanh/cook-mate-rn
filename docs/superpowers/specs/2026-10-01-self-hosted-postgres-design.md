# Replace Supabase Postgres with self-hosted Postgres — design

Date: 2026-10-01
Status: approved in brainstorming, pending spec review

## Context and goal

The backend (pipeline, operator console, REST API) talks to Postgres through
node-postgres in `backend/src/db.ts`, using `DATABASE_URL`. Today that URL
points at a Supabase project. Nothing else touches the database: the app reads
only through the API, and the voice agent never connects.

This is **sub-project 3 of 3** in removing Supabase:

1. Clerk replaces Supabase Auth (done, merged into local `main`).
2. MinIO replaces Supabase Storage (done, merged into local `main`).
3. **Self-hosted Postgres replaces the Supabase database (this spec).**

What the code already gets right:

- **The schema is portable.** Every Supabase-specific statement in
  `backend/migrations/` is guarded: the `anon` / `authenticated` grants and RLS
  only apply when those roles exist, the `auth.uid()` policies are created only
  on Supabase, and 0017 drops them. The only extension is `pg_trgm`, which ships
  with stock Postgres.
- **`npm run setup`** already migrates and seeds an empty database in order.

What is wrong or left over:

- **TLS guess in `db.ts`:**
  `ssl: env.databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false }`.
  A compose hostname (`postgres:5432`) or `127.0.0.1` gets TLS forced on, and a
  stock Postgres container offers none, so the connection fails.
- **Untested in CI:** the Postgres tests (`test/api.test.ts`,
  `test/locks.test.ts`) skip themselves there, because CI has no database.
- **Supabase leftovers:**
  - "Supabase pooler" comments in `db.ts` and `env.ts`
  - `"supabase"` in the `tsconfig.json` `exclude`
  - the `supabase/.temp/` CLI state and its `.gitignore` lines
  - the `supabase` agent skill
  - Supabase paragraphs in the READMEs and `.env.example` files

### Decisions

- **No data is copied (fresh start).** The new database starts empty: setup
  migrates and seeds it, then the pipeline crawls and publishes again. Users'
  favorites and shopping signals, and any hand-reviewed recipes, are lost on
  purpose. There is no dump/restore tooling.
- **Postgres runs in docker compose**, beside MinIO: the official
  `postgres:17-alpine` image, pinned to that major version.
- **TLS comes from the URL.** `db.ts` stops setting `ssl` and leaves it to the
  `sslmode` query parameter in `DATABASE_URL`, which node-postgres already
  understands.
- **CI runs the database tests** against a Postgres service container, and
  fails rather than skips when that database is unreachable.
- **Migrations stay manual.** Containers never migrate on boot. Two services
  migrating at startup would race, and nothing migrates implicitly today.
- **Agent skills:** the `supabase` skill (platform, CLI, Data API) is removed.
  `supabase-postgres-best-practices` is kept, because its content is plain
  Postgres guidance.

### Success criteria

- `docker compose up` starts Postgres, waits for it to be healthy, then starts
  the API and the console against it.
- `npm run setup` against an empty compose database applies migrations
  0000–0017 and seeds the canonical dictionary with no errors. Running
  `npm run migrate` a second time applies nothing.
- A `DATABASE_URL` with no `sslmode` connects over plain TCP to any host.
  `?sslmode=verify-full` and `?sslmode=no-verify` turn TLS on.
- In CI, `api.test.ts` and `locks.test.ts` run and pass, and an unreachable CI
  database fails the job.
- No backend source file, compose file, CI file or current doc tells anyone to
  use Supabase. Applied migrations and historical docs are exempt (see Out of
  scope).

## Architecture

### Components

**`docker-compose.yml`: new `postgres` service**

```yaml
postgres:
  image: postgres:17-alpine
  environment:
    POSTGRES_USER: ${POSTGRES_USER:-cookmate}
    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in the root .env}
    POSTGRES_DB: ${POSTGRES_DB:-cookmate}
  ports:
    - "127.0.0.1:5432:5432" # user data: reachable from this machine only
  volumes:
    - postgres-data:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
    interval: 5s
    timeout: 3s
    retries: 10
  restart: unless-stopped
```

- **Credentials** come from the root `.env`, beside `MINIO_ROOT_*`.
  `POSTGRES_PASSWORD` is required. User and database default to `cookmate`.
- **Port:** bound to 127.0.0.1, unlike MinIO's 9000 (which phones need for
  images). Host-side commands (`npm run dev -- …`, `npm test`) reach it on
  `localhost:5432`.
- **Volume:** a new top-level `postgres-data:` entry.

**`docker-compose.yml`: `api` and `crawler`**

- Both get this in their `environment` (which overrides `env_file`), interpolated
  from the root `.env`:
  ```yaml
  DATABASE_URL: postgres://${POSTGRES_USER:-cookmate}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-cookmate}
  ```
- Their `depends_on` becomes `minio` (as now) plus
  `postgres: { condition: service_healthy }`. That needs the long form of
  `depends_on`, so `minio` moves to `{ condition: service_started }`.
- **`backend/.env`** keeps only the host-side URL
  (`postgres://cookmate:…@localhost:5432/cookmate`), the same split
  `S3_ENDPOINT` already uses.
- **The header comment** in the compose file lists the new root `.env` variables
  and the one-off `npm run setup` step.

**`backend/src/db.ts`**

- The pool options move into an exported function so they can be tested without
  connecting:
  ```ts
  /** The pool's options. TLS is the URL's business: see `sslmode` below. */
  export function poolConfig(connectionString: string): pg.PoolConfig {
    return {
      connectionString,
      max: Math.max(4, env.crawlConcurrency + 2),
      connectionTimeoutMillis: env.dbConnectTimeoutMs,
    };
  }
  ```
  `pool()` calls `new pg.Pool(poolConfig(env.databaseUrl))`.
- **No `ssl` key.** node-postgres reads `sslmode` from the connection string:
  - absent: plain TCP
  - `verify-full`: TLS, and the certificate must verify. This is the one to
    document.
  - `require`: pg 8.23 treats it as `verify-full`, but prints a security warning
    that its meaning changes in pg 9. The docs steer people to `verify-full`.
  - `no-verify`: TLS without checking the certificate (self-signed servers)

  The comment above `poolConfig` names these values.
- **Comments:** the ones about the Supabase CA and the "pooler in a distant
  region" are reworded for Postgres in general. The timeout reasoning stays,
  without the Supabase wording.
- **Unchanged:** the 30s connect timeout and the pool `'error'` listener.

**`backend/src/env.ts`**

- The `dbConnectTimeoutMs` comment drops "A Supabase pooler…" and says a remote
  Postgres can take seconds to accept a connection. No behaviour change.

**`backend/test/db-helpers.ts`** (new)

- Replaces the two copies of `skipReason()`:
  ```ts
  /**
   * Why the Postgres tests should skip, or false to run them. With
   * REQUIRE_DATABASE=1 (CI) an unreachable database throws instead: a broken
   * service container must fail the job, not turn into green skips.
   */
  export async function databaseSkipReason(): Promise<string | false>
  ```
- **Behaviour:**
  - It loads `dotenv/config` first, as `locks.test.ts` does now.
  - `DATABASE_URL` unset gives `'DATABASE_URL not set'`.
  - Otherwise it runs `select 1` through `src/db.js`. Success gives `false`.
  - On failure it returns `database unreachable (<first 60 chars>)`, or, when
    `process.env.REQUIRE_DATABASE === '1'`, throws
    `REQUIRE_DATABASE=1 but the database is unreachable: <error>` with the
    original error as `cause`.
  - An unset `DATABASE_URL` under `REQUIRE_DATABASE=1` throws too.
- **Callers:** `api.test.ts` and `locks.test.ts` call it in place of their local
  functions. `api.test.ts` still calls `applyTestAuthEnv()` first, before
  anything under `src/` loads.

**`.github/workflows/ci.yml`, `backend` job**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    env:
      POSTGRES_USER: cookmate
      POSTGRES_PASSWORD: cookmate
      POSTGRES_DB: cookmate
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U cookmate -d cookmate"
      --health-interval 5s --health-timeout 3s --health-retries 10
env:
  # 127.0.0.1, not localhost: the old db.ts forced TLS on any URL without
  # "localhost" in it, so this host would catch that regression.
  DATABASE_URL: postgres://cookmate:cookmate@127.0.0.1:5432/cookmate
  REQUIRE_DATABASE: '1'
```

- **Steps:** after `npm ci` and typecheck, a `Migrate` step runs
  `npm run migrate` twice, so the second run proves it applies nothing and
  doesn't fail. Then `npm test`.
- **The comment** above the test step is rewritten: the DB tests run against the
  service container, while storage tests still use the fake S3 client or the
  file driver, and the live S3 test skips.
- The `agent` job is unchanged.

**Cleanup**

- `tsconfig.json`: remove `"supabase"` from `exclude`.
- `.gitignore`: remove the `## Supabase CLI local state` / `supabase/.temp/`
  lines. This lands in the same commit as the README runbook that tells the user
  to delete `supabase/`. The implementer never deletes `supabase/.temp/`: it
  holds the user's CLI link state.
- Remove `.agents/skills/supabase/` and its entry in `skills-lock.json`. Keep
  `supabase-postgres-best-practices` and its entry.

### Data flow

```
host:      npm run dev / npm test ── localhost:5432 ──┐
compose:   api, crawler ─────────── postgres:5432 ────┼─▶ postgres (volume postgres-data)
CI:        npm run migrate / npm test ─ 127.0.0.1:5432 ┘   (service container)
```

The schema, queries, advisory locks and the API contract are unchanged. Only
where the URL points and how TLS is chosen change.

### Cutover runbook (goes into `backend/README.md`)

"Moving from Supabase Postgres (a fresh start, nothing is copied)":

1. In the root `.env`, set `POSTGRES_PASSWORD` (and optionally `POSTGRES_USER`
   and `POSTGRES_DB`). Then run `docker compose up -d postgres`.
2. In `backend/.env`, set
   `DATABASE_URL=postgres://cookmate:<password>@localhost:5432/cookmate`.
3. Run `npm run setup` in `backend/`. This applies migrations 0000–0017
   (including the Clerk user-id change) and seeds the canonical dictionary.
4. Run `npm run dev -- storage check` and `npm run dev -- images --check`, then
   `npm run pipeline` and `npm run publish`, to fill the database again.
5. Once the app works against it, delete the local Supabase CLI state
   (`rm -rf supabase/`, which shows as untracked until you do), and pause or
   delete the Supabase project in its dashboard.

Data that existed only in Supabase (favorites, shopping signals, hand-reviewed
recipes) is gone after this. That is the chosen fresh start.

## Error handling

- **Database not running:** compose's healthcheck holds back `api` and
  `crawler`. Host-side commands fail with pg's connection error within
  `DB_CONNECT_TIMEOUT_MS`, as they do now.
- **`POSTGRES_PASSWORD` unset:** compose refuses to start and names the
  variable (the `:?` form).
- **TLS mismatch** (`sslmode=verify-full` against a server without TLS, or a
  certificate that doesn't verify): pg's own error reaches the caller. The
  README's `sslmode` notes give the fix (`no-verify` for self-signed, nothing for
  local).
- **CI database unreachable:** `databaseSkipReason()` throws, so the DB test
  files fail and the job goes red.

## Testing

- **`test/db.test.ts` (new):**
  - `poolConfig('postgres://u:p@postgres:5432/db')` has no `ssl` key, and its
    `connectionString` is passed through unchanged.
  - `poolConfig('postgres://u:p@db.example.com:5432/db?sslmode=verify-full')` has no
    `ssl` key, and keeps `sslmode=verify-full` in `connectionString`.
  - `max` and `connectionTimeoutMillis` follow `CRAWL_CONCURRENCY` and
    `DB_CONNECT_TIMEOUT_MS`.
- **`test/db-helpers.test.ts` (new):**
  - No `DATABASE_URL` gives `'DATABASE_URL not set'`.
  - An unreachable URL (`postgres://x:y@127.0.0.1:1/none`, with a short connect
    timeout) gives a string starting `database unreachable`.
  - The same unreachable URL with `REQUIRE_DATABASE=1` rejects with a message
    naming `REQUIRE_DATABASE`.
  - These tests set `DATABASE_URL` to their own values and close the pool
    between cases, so they never touch a real database.
- **`api.test.ts` / `locks.test.ts`:** unchanged assertions. They now go through
  the shared helper.
- **CI** is the integration test for everything else: migrations on stock
  Postgres 17, running them twice, and the DB tests over `127.0.0.1` without TLS.
- **Manual check before merge:** run the CI sequence locally against a
  throwaway `postgres:17-alpine` container on a spare port (not the user's
  database): migrate twice, `npm run setup`, then `npm test` with
  `DATABASE_URL` and `REQUIRE_DATABASE=1` set. Then `docker compose config` to
  validate the compose file.

## Documentation

- **`backend/README.md`:**
  - The quick start uses `docker compose up -d postgres minio`, then
    `npm run setup`.
  - The "pointing at a Supabase project" paragraph is replaced by a short
    "Remote Postgres" note on `sslmode` (`verify-full` for a real
    certificate, `no-verify` for a self-signed one, and why not `require`).
  - The cutover runbook above is added.
  - The Docker section names `POSTGRES_*` in the root `.env`.
- **Root `README.md`** (the user's uncommitted file, edited but not committed):
  - The env-table row for `backend/.env` drops "service-role key".
  - The compose setup lines mention `POSTGRES_*`.
- **`CLAUDE.md` / `backend/CLAUDE.md`:** neither mentions Supabase. No change.
- **`.env.example` files:** the implementer can't edit these (permissions).
  The final message hands the user replacement text:
  - **Root:** add
    ```
    POSTGRES_USER=cookmate
    POSTGRES_PASSWORD=change-me-postgres
    POSTGRES_DB=cookmate
    ```
    and remove any remaining `SUPABASE` lines.
  - **Backend:** a complete database block that replaces whatever is there now:
    `DATABASE_URL=postgres://cookmate:change-me-postgres@localhost:5432/cookmate`,
    a comment on the compose override and on `sslmode`, and
    `DB_CONNECT_TIMEOUT_MS`. Remove the remaining `SUPABASE` mentions.
  - **Expected `env:check` drift:** it may report drift until the user pastes
    these. Compose variables (`POSTGRES_*`) are not read by code, so they may
    not appear in it at all.

## Out of scope

- **Copying data** out of Supabase (by decision: fresh start).
- **Backups, replication, tuning and a production deployment** of Postgres. A
  remote server is supported through `sslmode`, but provisioning one is not part
  of this.
- **Running migrations automatically** on container start.
- **Editing applied migrations.** Their Supabase guards are harmless on stock
  Postgres, and editing an applied migration breaks its recorded state.
- **Historical docs:** `docs/prd.md`, `docs/brief.md` and
  `docs/specs/spec-crawl-engine/`.
- **Deliberate Supabase mentions that stay:**
  - the `RAW_PAGE_STORE="supabase"` rejection test
  - the "legacy Supabase path" comment in `auth.test.ts`
  - the old-client note in `lib/env.ts`
- **`supabase-postgres-best-practices`** stays (see Decisions).
