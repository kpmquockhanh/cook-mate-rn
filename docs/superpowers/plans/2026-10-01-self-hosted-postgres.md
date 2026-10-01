# Self-hosted Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the backend on a self-hosted Postgres 17 in docker compose instead of Supabase. TLS is chosen by the URL's `sslmode`, and CI runs the database tests for real.

**Architecture:**
- **`db.ts`:** stops guessing TLS from the hostname. The pool options move into an exported `poolConfig()` with no `ssl` key, so node-postgres applies `sslmode` from `DATABASE_URL`.
- **Tests:** a shared `test/db-helpers.ts` replaces the two copies of `skipReason()`. It fails instead of skipping when `REQUIRE_DATABASE=1`.
- **Compose:** gains a health-checked `postgres` service. `api` and `crawler` get a compose-interpolated `DATABASE_URL`.
- **CI:** gains a Postgres service container.
- **Cleanup:** Supabase leftovers and docs.

**Tech Stack:** Node 22, TypeScript run by `tsx`, node-postgres 8.23 (`pg`), `node:test`, `postgres:17-alpine`, docker compose v5, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-01-self-hosted-postgres-design.md`

## Global Constraints

- **Git:**
  - Work on branch `self-hosted-postgres`.
  - Never commit `README.md`, `app.json`, `CLAUDE.md` or `backend/CLAUDE.md`: they hold the user's own uncommitted edits. Task 5 edits `README.md` and `backend/CLAUDE.md` but leaves them uncommitted.
  - Stage files by explicit path, never `git add -A` or `git add .`. Never stash.
- **`.env` files:**
  - Never read any `.env` file.
  - Never edit `.env.example` files: the permission settings block them. Their text goes to the user in the final message (spec, Documentation).
- **Databases:**
  - Never run migrations, `npm run setup` or tests against the user's database.
  - Live checks use a throwaway container: `docker run --rm --name cm-pg-check … -p 127.0.0.1:55432:5432 postgres:17-alpine`, or a compose project named `cm-verify`. Always tear it down afterwards.
- **Tests:** `node:test` via `tsx --test`. `cd backend && npm test` must still pass with no database, no MinIO and no network.
- **dotenv:**
  - `backend/src/env.ts` does `import 'dotenv/config'`, which loads the developer's `backend/.env` into tests.
  - dotenv never overrides a key that already exists. So a test that needs `DATABASE_URL` absent sets it to `''`, never `delete`.
- **TLS rules:**
  - `db.ts` never sets `ssl`.
  - Documented `sslmode` values: none (plain TCP), `verify-full` (TLS, verified), `no-verify` (TLS, self-signed).
  - `require` is documented only as "don't: pg 8.23 warns its meaning changes in pg 9".
- **Compose variables (root `.env`):**
  - `POSTGRES_USER` (default `cookmate`) and `POSTGRES_DB` (default `cookmate`).
  - `POSTGRES_PASSWORD` is required, with the message `set POSTGRES_PASSWORD in the root .env`.
  - The image is `postgres:17-alpine`.
  - The host port is `127.0.0.1:5432:5432`.
  - The volume is `postgres-data`.
- **CI:**
  - Postgres credentials `cookmate`/`cookmate`/`cookmate`.
  - `DATABASE_URL=postgres://cookmate:cookmate@127.0.0.1:5432/cookmate`.
  - `REQUIRE_DATABASE: '1'`.
- **Commits:** follow the repo's style: a sentence-case summary line with no `feat:` prefix, ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Any non-localhost host with no `sslmode`** (`127.0.0.1`, the compose name `postgres`, a LAN IP). Expected: plain TCP, no "server does not support SSL connections". This is the bug that ships today, confirmed against a real Postgres 17 while planning. Pinned by the `pg.Client` TLS tests in Task 1 and by CI's `127.0.0.1` URL in Task 3.
2. **A self-signed remote server with `?sslmode=no-verify`.** Expected: TLS with `rejectUnauthorized: false`, not a certificate error and not plain TCP. Pinned in Task 1.
3. **CI with `REQUIRE_DATABASE=1` but no `DATABASE_URL`**, e.g. someone renames the env key. Expected: the DB test files fail and name the problem, rather than skipping green. Pinned in Task 2.
4. **A `POSTGRES_PASSWORD` containing URL-reserved characters** (`@`, `/`, `:`, `#`, `%`). Compose pastes it raw into `DATABASE_URL`, so the URL breaks in confusing ways. Expected: the docs say to use letters and digits only. Pinned by the compose comment and the README text in Tasks 4 and 5, and by the `docker compose config` check in Task 4.
5. **Another Postgres already listening on host port 5432** (Homebrew, Postgres.app). Compose fails to bind it, or worse, host commands connect to the wrong server. Expected: the README names the symptom and the fix. Pinned by the README text in Task 5.

---

### Task 1: `poolConfig()` and URL-driven TLS in `db.ts`

**Files:**
- Modify: `backend/src/db.ts:13-27` (the `new pg.Pool({...})` options)
- Modify: `backend/src/env.ts:62-65` (the `dbConnectTimeoutMs` comment)
- Create: `backend/test/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function poolConfig(connectionString: string): pg.PoolConfig` in `backend/src/db.ts`. `pool()` keeps its signature and builds `new pg.Pool(poolConfig(env.databaseUrl))`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/db.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { poolConfig } from '../src/db.js';
import { env } from '../src/env.js';

// What pg itself will do with these options: a Client resolves its TLS
// settings in the constructor and connects only on .connect(), so this
// checks the behaviour without a server.
function tlsOf(connectionString: string): unknown {
  return (new pg.Client(poolConfig(connectionString)) as unknown as { ssl: unknown }).ssl;
}

test('a compose hostname with no sslmode connects without TLS', () => {
  assert.equal(tlsOf('postgres://u:p@postgres:5432/db'), false);
});

test('127.0.0.1 with no sslmode connects without TLS', () => {
  assert.equal(tlsOf('postgres://u:p@127.0.0.1:5432/db'), false);
});

test('sslmode=verify-full turns on verified TLS', () => {
  const ssl = tlsOf('postgres://u:p@db.example.com:5432/db?sslmode=verify-full');
  assert.ok(ssl && typeof ssl === 'object', 'expected TLS options');
  assert.notEqual((ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, false);
});

test('sslmode=no-verify turns on TLS without certificate checks', () => {
  const ssl = tlsOf('postgres://u:p@db.example.com:5432/db?sslmode=no-verify');
  assert.deepEqual(ssl, { rejectUnauthorized: false });
});

test('poolConfig never sets ssl itself and passes the URL through', () => {
  const url = 'postgres://u:p@db.example.com:5432/db?sslmode=verify-full';
  const config = poolConfig(url);
  assert.equal('ssl' in config, false);
  assert.equal(config.connectionString, url);
});

test('pool size and connect timeout come from env', () => {
  const config = poolConfig('postgres://u:p@postgres:5432/db');
  assert.equal(config.max, Math.max(4, env.crawlConcurrency + 2));
  assert.equal(config.connectionTimeoutMillis, env.dbConnectTimeoutMs);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/db.test.ts`
Expected: FAIL. `poolConfig` is not exported yet, so every test errors with a SyntaxError naming `poolConfig` (or "does not provide an export named 'poolConfig'").

- [ ] **Step 3: Write the implementation**

In `backend/src/db.ts`, replace the whole `if (!poolRef) { poolRef = new pg.Pool({ ... }); ... }` options block, from line 13 to the closing `});` of the `Pool` options, so that `pool()` reads:

```ts
let poolRef: pg.Pool | null = null;

/**
 * The pool's options, split out so tests can check them without connecting.
 *
 * TLS is the URL's business: there is deliberately no `ssl` key, so pg applies
 * `sslmode` from the connection string. No `sslmode` means plain TCP (docker
 * compose, localhost). `?sslmode=verify-full` means TLS with a certificate
 * that must verify; `?sslmode=no-verify` means TLS against a self-signed
 * server. Avoid `require`: pg 8 treats it as verify-full but warns that pg 9
 * changes its meaning.
 */
export function poolConfig(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: Math.max(4, env.crawlConcurrency + 2),
    // Without this a wrong host hangs the API request (or the test suite)
    // instead of failing; pg waits indefinitely by default. It is generous
    // because a remote server can legitimately take several seconds to accept
    // a connection, and a timeout shorter than a healthy connect turns
    // ordinary latency into an outage.
    connectionTimeoutMillis: env.dbConnectTimeoutMs,
  };
}

export function pool(): pg.Pool {
  if (!poolRef) {
    poolRef = new pg.Pool(poolConfig(env.databaseUrl));

    // An idle client whose connection drops - a laptop sleeping, wifi changing,
    // a server restarting - makes pg emit 'error' on the POOL, not on any query.
    // Node treats an unhandled 'error' event as fatal, so without this listener
    // a transient network blip takes down the console or the API rather than
    // costing one reconnect.
    poolRef.on('error', (error) => {
      log.warn('idle client error (the pool will reconnect)', String(error));
    });
  }
  return poolRef;
}
```

Keep the existing `poolRef.on('error', …)` body as shown. Only "a pooler recycling" becomes "a server restarting". Everything below `pool()` (`query`, `one`, `transaction`, `close`) is unchanged.

In `backend/src/env.ts`, replace lines 62-64:

```ts
  // A Supabase pooler in a distant region can take several seconds to accept a
  // connection. Too tight a timeout does not protect anything - it just turns
  // ordinary latency into a failed request.
```

with:

```ts
  // A remote Postgres can take several seconds to accept a connection. Too
  // tight a timeout does not protect anything - it just turns ordinary latency
  // into a failed request.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/db.test.ts`
Expected: PASS, 6/6. The `verify-full` case must not print pg's "SECURITY WARNING" (only `require`/`prefer`/`verify-ca` trigger it). If it does, the test URL is wrong.

- [ ] **Step 5: Live check against a throwaway Postgres**

```bash
docker run -d --rm --name cm-pg-check -e POSTGRES_USER=cookmate -e POSTGRES_PASSWORD=cookmate -e POSTGRES_DB=cookmate -p 127.0.0.1:55432:5432 postgres:17-alpine
until docker exec cm-pg-check pg_isready -U cookmate -d cookmate; do sleep 1; done
cd backend && DATABASE_URL=postgres://cookmate:cookmate@127.0.0.1:55432/cookmate npm run migrate
docker stop cm-pg-check
```

Expected: `applied 18 migration(s)`. Before this task the same command failed with `The server does not support SSL connections`.

- [ ] **Step 6: Run the suite and typecheck**

Run: `cd backend && npm run typecheck && npm test`
Expected: typecheck clean, and all tests pass (DB tests skip if no database is configured).

- [ ] **Step 7: Commit**

```bash
git add backend/src/db.ts backend/src/env.ts backend/test/db.test.ts
git commit -m "Take Postgres TLS from the URL's sslmode instead of guessing from the hostname

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared `databaseSkipReason()` that fails under `REQUIRE_DATABASE=1`

**Files:**
- Create: `backend/test/db-helpers.ts`
- Create: `backend/test/db-helpers.test.ts`
- Modify: `backend/test/locks.test.ts:1-21` (the header comment, `skipReason()`, and `const skip = …`)
- Modify: `backend/test/api.test.ts:4,11-26` (the imports, the comment and `skipReason()`)

**Interfaces:**
- Consumes: `close()` and `query()` from `backend/src/db.ts` (unchanged).
- Produces: `export async function databaseSkipReason(): Promise<string | false>` in `backend/test/db-helpers.ts`. Task 3's CI sets `REQUIRE_DATABASE: '1'` and relies on this to fail.

`db-helpers.ts` must import `../src/db.js` **dynamically**, inside the function, never at the top. `api.test.ts` imports it statically, and ESM hoists static imports above `applyTestAuthEnv()`, so a top-level import of `src/` would load `env.ts` before the test's auth env is in place.

- [ ] **Step 1: Write the failing test**

Create `backend/test/db-helpers.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { close } from '../src/db.js';
import { databaseSkipReason } from './db-helpers.js';

// Nothing listens on port 1, so this fails fast with ECONNREFUSED and never
// touches a real database.
const UNREACHABLE = 'postgres://x:y@127.0.0.1:1/none';

const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  REQUIRE_DATABASE: process.env.REQUIRE_DATABASE,
};

afterEach(async () => {
  // The pool is built once per URL; drop it so the next case connects afresh.
  await close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('no DATABASE_URL skips with a reason', async () => {
  process.env.DATABASE_URL = ''; // '' not delete: dotenv would refill a missing key
  process.env.REQUIRE_DATABASE = '';
  assert.equal(await databaseSkipReason(), 'DATABASE_URL not set');
});

test('an unreachable database skips with a reason', async () => {
  process.env.DATABASE_URL = UNREACHABLE;
  process.env.REQUIRE_DATABASE = '';
  const reason = await databaseSkipReason();
  assert.equal(typeof reason, 'string');
  assert.match(reason as string, /^database unreachable/);
});

test('REQUIRE_DATABASE=1 turns an unreachable database into a failure', async () => {
  process.env.DATABASE_URL = UNREACHABLE;
  process.env.REQUIRE_DATABASE = '1';
  await assert.rejects(databaseSkipReason(), (error: Error) => {
    assert.match(error.message, /^REQUIRE_DATABASE=1 but the database is unreachable: /);
    assert.ok(error.cause, 'the connection error should be kept as cause');
    return true;
  });
});

test('REQUIRE_DATABASE=1 with no DATABASE_URL is a failure, not a skip', async () => {
  process.env.DATABASE_URL = '';
  process.env.REQUIRE_DATABASE = '1';
  await assert.rejects(databaseSkipReason(), /^Error: REQUIRE_DATABASE=1 but DATABASE_URL is not set/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/db-helpers.test.ts`
Expected: FAIL with a module-not-found error for `./db-helpers.js`.

- [ ] **Step 3: Write the helper**

Create `backend/test/db-helpers.ts`:

```ts
/**
 * Why the Postgres tests should skip, or false to run them.
 *
 * Offline and on a laptop with no database they skip, so `npm test` stays
 * green. With REQUIRE_DATABASE=1 (CI) a missing or unreachable database throws
 * instead: a broken service container must fail the job, not turn into green
 * skips nobody reads.
 *
 * src/db.js is imported inside the function on purpose. Callers import this
 * module statically, and api.test.ts must set its auth env before anything
 * under src/ loads.
 */
export async function databaseSkipReason(): Promise<string | false> {
  // Load the project's .env the way every entry point does, so a developer
  // with a working database actually runs these instead of watching them skip.
  await import('dotenv/config');
  const required = process.env.REQUIRE_DATABASE === '1';

  if (!process.env.DATABASE_URL) {
    if (required) throw new Error('REQUIRE_DATABASE=1 but DATABASE_URL is not set');
    return 'DATABASE_URL not set';
  }

  try {
    const { query } = await import('../src/db.js');
    await query('select 1');
    return false;
  } catch (error) {
    if (required) {
      throw new Error(`REQUIRE_DATABASE=1 but the database is unreachable: ${String(error)}`, {
        cause: error,
      });
    }
    return `database unreachable (${String(error).slice(0, 60)})`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/db-helpers.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Switch `locks.test.ts` to the helper**

Replace lines 1-21 of `backend/test/locks.test.ts`: the imports, the header comment, the whole `async function skipReason()` and `const skip = await skipReason();`. The new text:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseSkipReason } from './db-helpers.js';

// The whole point of these locks is that they live in Postgres rather than in
// this process, so there is nothing to test without one. db-helpers.ts decides
// whether that skips (offline) or fails (CI, REQUIRE_DATABASE=1).
const skip = await databaseSkipReason();
```

Everything from `test('job locks', { skip }, …` down is unchanged.

- [ ] **Step 6: Switch `api.test.ts` to the helper**

In `backend/test/api.test.ts`, add the import after the existing `auth-helpers.js` import on line 4:

```ts
import { databaseSkipReason } from './db-helpers.js';
```

Then replace lines 11-26: the comment block starting `// These exercise real routes against a real database.`, the whole `async function skipReason()`, and `const skip = await skipReason();`. The new text:

```ts
// These exercise real routes against a real database. They run through
// app.inject(), so no port is bound and nothing listens - but they still need
// Postgres. db-helpers.ts decides whether a missing one skips (offline) or
// fails (CI, REQUIRE_DATABASE=1).
const skip = await databaseSkipReason();
```

`import 'dotenv/config'` on line 1 and the `applyTestAuthEnv()` call stay where they are.

- [ ] **Step 7: Verify both callers, with and without a database**

Run: `cd backend && DATABASE_URL='' npx tsx --test test/api.test.ts test/locks.test.ts`
Expected: both suites reported as skipped (`# SKIP DATABASE_URL not set`), exit 0.

Run: `cd backend && DATABASE_URL='' REQUIRE_DATABASE=1 npx tsx --test test/api.test.ts test/locks.test.ts`
Expected: non-zero exit. Both files fail with `REQUIRE_DATABASE=1 but DATABASE_URL is not set`.

Then against a throwaway database:

```bash
docker run -d --rm --name cm-pg-check -e POSTGRES_USER=cookmate -e POSTGRES_PASSWORD=cookmate -e POSTGRES_DB=cookmate -p 127.0.0.1:55432:5432 postgres:17-alpine
until docker exec cm-pg-check pg_isready -U cookmate -d cookmate; do sleep 1; done
cd backend && export DATABASE_URL=postgres://cookmate:cookmate@127.0.0.1:55432/cookmate REQUIRE_DATABASE=1
npm run migrate && npx tsx --test test/api.test.ts test/locks.test.ts
docker stop cm-pg-check
```

Expected: 22 tests pass, 0 skipped. The planning run on an empty migrated database gave exactly 22/22, and no seed is needed.

- [ ] **Step 8: Run the suite and typecheck**

Run: `cd backend && npm run typecheck && npm test`
Expected: typecheck clean, and all tests pass.

- [ ] **Step 9: Commit**

```bash
git add backend/test/db-helpers.ts backend/test/db-helpers.test.ts backend/test/locks.test.ts backend/test/api.test.ts
git commit -m "Share the database skip check and fail instead of skipping when REQUIRE_DATABASE=1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Postgres service in CI

**Files:**
- Modify: `.github/workflows/ci.yml` (the `backend` job: lines 19-38)

**Interfaces:**
- Consumes: `databaseSkipReason()` honouring `REQUIRE_DATABASE=1` (Task 2), and `poolConfig()` connecting to `127.0.0.1` without TLS (Task 1).
- Produces: nothing code consumes.

GitHub Actions can't run locally, so this task's test is to replay its exact command sequence against a throwaway container with the same image, credentials and URL shape.

- [ ] **Step 1: Replace the `backend` job**

In `.github/workflows/ci.yml`, replace the whole `backend:` job (from `  backend:` down to the `working-directory: backend` line under `- name: Test`) with:

```yaml
  backend:
    name: Backend
    runs-on: ubuntu-latest
    # The same image docker-compose.yml runs. Throwaway credentials: this
    # database lives for one job.
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
      # 127.0.0.1, not localhost: db.ts used to force TLS on any URL without
      # "localhost" in it, so this host catches that regression.
      DATABASE_URL: postgres://cookmate:cookmate@127.0.0.1:5432/cookmate
      # The DB tests fail instead of skipping if this database is unreachable.
      REQUIRE_DATABASE: '1'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
        working-directory: backend
      - name: Typecheck
        run: npm run typecheck
        working-directory: backend
      # Twice: every migration must be re-runnable, and the second run must
      # find nothing left to apply.
      - name: Migrate
        run: npm run migrate && npm run migrate
        working-directory: backend
      # The DB tests (api, locks) run against the service container above.
      # Storage tests still need no object store: they use a fake S3 client or
      # the filesystem driver, and the live MinIO test skips itself.
      - name: Test
        run: npm test
        working-directory: backend
```

The `agent:` job and everything above `jobs:` stay unchanged.

- [ ] **Step 2: Check the YAML parses and has the expected shape**

Run:

```bash
python3 -c "
import yaml
w = yaml.safe_load(open('.github/workflows/ci.yml'))
b = w['jobs']['backend']
assert b['services']['postgres']['image'] == 'postgres:17-alpine'
assert b['env']['DATABASE_URL'] == 'postgres://cookmate:cookmate@127.0.0.1:5432/cookmate'
assert b['env']['REQUIRE_DATABASE'] == '1'
assert [s.get('name') for s in b['steps']][-3:] == ['Typecheck', 'Migrate', 'Test']
assert 'agent' in w['jobs']
print('ci.yml ok')
"
```

Expected: `ci.yml ok`.

- [ ] **Step 3: Replay the CI job locally**

```bash
docker run -d --rm --name cm-pg-check -e POSTGRES_USER=cookmate -e POSTGRES_PASSWORD=cookmate -e POSTGRES_DB=cookmate -p 127.0.0.1:55432:5432 postgres:17-alpine
until docker exec cm-pg-check pg_isready -U cookmate -d cookmate; do sleep 1; done
cd backend && export DATABASE_URL=postgres://cookmate:cookmate@127.0.0.1:55432/cookmate REQUIRE_DATABASE=1
npm run typecheck && npm run migrate && npm run migrate && npm test
docker stop cm-pg-check
```

Expected:
- the first migrate prints `applied 18 migration(s)`, and the second `database already up to date`
- `npm test` has 0 failures, and the only skipped tests are the live S3 integration ones (2 during planning)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Run the backend's database tests in CI against a Postgres service container

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `postgres` service in docker compose

**Files:**
- Modify: `docker-compose.yml` (the header comment, a new `postgres` service, the `api` and `crawler` `environment`/`depends_on`, and top-level `volumes`)

**Interfaces:**
- Consumes: Task 1, because the `api`/`crawler` URL uses host `postgres` with no `sslmode`, which only works after Task 1.
- Produces: the service name `postgres`, the root `.env` variables `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, and the volume `postgres-data`. Task 5's docs refer to all of these.

- [ ] **Step 1: Update the header comment**

Replace the `# Usage:` block at the top of `docker-compose.yml` (from `# Usage:` through `#   docker compose up --build`) with:

```yaml
# Usage:
#   cp .env.example .env                   # MINIO_ROOT_USER / MINIO_ROOT_PASSWORD,
#                                           # POSTGRES_PASSWORD (+ optional POSTGRES_USER,
#                                           # POSTGRES_DB) - compose reads the root .env
#   cp backend/.env.example backend/.env   # fill in DATABASE_URL (the localhost one, for
#                                           # host-side commands), provider keys,
#                                           # S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY
#                                           # (the MinIO credentials), S3_PUBLIC_URL,
#                                           # REVIEW_USERNAME/PASSWORD,
#                                           # CLERK_ISSUER, CLERK_AUTHORIZED_PARTIES,
#                                           # LIVEKIT_URL/_API_KEY/_API_SECRET (voice tokens)
#   cp agent/.env.example agent/.env       # fill in LIVEKIT_*
#   docker compose up -d postgres minio
#   (cd backend && npm run setup)          # once, on a new database: migrate + seed
#   docker compose up --build
```

- [ ] **Step 2: Add the `postgres` service**

Insert this as the first entry under `services:`, above the `minio` comment block:

```yaml
  # The database for the pipeline and the API. Nothing migrates on start: run
  # `npm run setup` from backend/ once against a new database (host-side
  # commands reach it on localhost:5432).
  #
  # POSTGRES_PASSWORD is pasted into the api/crawler DATABASE_URL below as-is,
  # so keep it to letters and digits - '@', '/', ':', '#' or '%' would break
  # the URL.
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

- [ ] **Step 3: Point `api` at it**

Replace the `api` service's `environment:` and `depends_on:` blocks with:

```yaml
    environment:
      # localhost inside a container is the container itself. S3_PUBLIC_URL
      # is not overridden: it has to be an address the phone can reach.
      S3_ENDPOINT: http://minio:9000
      # Overrides backend/.env's localhost URL, which is for host-side commands.
      DATABASE_URL: postgres://${POSTGRES_USER:-cookmate}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-cookmate}
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_started
```

- [ ] **Step 4: Point `crawler` at it**

Replace the `crawler` service's `environment:` and `depends_on:` blocks with:

```yaml
    environment:
      # The console binds 127.0.0.1 by default, which is the container's own
      # loopback interface - unreachable through the port mapping below even
      # with it published. This opens it up instead, which is only safe
      # because startConsole() refuses to run without REVIEW_USERNAME/
      # REVIEW_PASSWORD (see backend/src/ui/server.ts).
      REVIEW_HOST: "0.0.0.0"
      S3_ENDPOINT: http://minio:9000
      DATABASE_URL: postgres://${POSTGRES_USER:-cookmate}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-cookmate}
    depends_on:
      postgres:
        condition: service_healthy
      minio:
        condition: service_started
```

- [ ] **Step 5: Add the volume**

Replace the top-level `volumes:` block with:

```yaml
volumes:
  minio-data:
  postgres-data:
```

- [ ] **Step 6: Validate the rendered config**

The root `.env` may lack these variables, and it must not be read. So pass dummy values in the shell environment, which take precedence over `.env`:

```bash
POSTGRES_PASSWORD=Check123 MINIO_ROOT_USER=check MINIO_ROOT_PASSWORD=check12345 \
  docker compose -p cm-verify config --format json | python3 -c "
import json, sys
c = json.load(sys.stdin)
s = c['services']
assert s['postgres']['image'] == 'postgres:17-alpine'
assert s['postgres']['ports'][0]['host_ip'] == '127.0.0.1'
url = 'postgres://cookmate:Check123@postgres:5432/cookmate'
assert s['api']['environment']['DATABASE_URL'] == url, s['api']['environment']['DATABASE_URL']
assert s['crawler']['environment']['DATABASE_URL'] == url
for svc in ('api', 'crawler'):
    assert s[svc]['depends_on']['postgres']['condition'] == 'service_healthy'
    assert s[svc]['depends_on']['minio']['condition'] == 'service_started'
assert 'postgres-data' in c['volumes']
print('compose ok')
"
```

Expected: `compose ok`.

Then check that the password is required:

Run: `MINIO_ROOT_USER=check MINIO_ROOT_PASSWORD=check12345 POSTGRES_PASSWORD= docker compose -p cm-verify config >/dev/null`
Expected: non-zero exit, with an error containing `set POSTGRES_PASSWORD in the root .env`.

- [ ] **Step 7: Live check that the service comes up healthy and migrates**

First check that nothing else holds port 5432: `lsof -nP -iTCP:5432 -sTCP:LISTEN`. If anything does, skip this step and record that in the report. Otherwise:

```bash
POSTGRES_PASSWORD=Check123 MINIO_ROOT_USER=check MINIO_ROOT_PASSWORD=check12345 \
  docker compose -p cm-verify up -d --wait postgres
cd backend && DATABASE_URL=postgres://cookmate:Check123@localhost:5432/cookmate npm run migrate
cd .. && POSTGRES_PASSWORD=Check123 MINIO_ROOT_USER=check MINIO_ROOT_PASSWORD=check12345 \
  docker compose -p cm-verify down -v
```

Expected:
- `up --wait` returns once the healthcheck passes
- migrate prints `applied 18 migration(s)`
- `down -v` removes the `cm-verify` containers and the `cm-verify_postgres-data` volume

The `-p cm-verify` project name keeps all of this apart from the user's own compose project and volumes.

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml
git commit -m "Run Postgres in docker compose and point the API and console at it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Remove Supabase leftovers and document the self-hosted database

**Files:**
- Modify: `tsconfig.json:23` (`exclude`)
- Modify: `.gitignore:80-81` (the Supabase CLI lines)
- Delete: `.agents/skills/supabase/` (whole directory, tracked files)
- Modify: `skills-lock.json` (remove the `"supabase"` entry)
- Modify: `backend/README.md` (Setup at ~L19-27, the Supabase paragraph at ~L129-130, the `api.test.ts` sentence at ~L389-390, Docker at ~L291-302)
- Modify, **not committed**: `README.md` (env table ~L53, Docker section ~L146-158), `backend/CLAUDE.md` (L22)

**Interfaces:**
- Consumes: the names from Task 4 (`postgres` service, `POSTGRES_*`, `127.0.0.1:5432`), the `sslmode` values from Task 1, and `REQUIRE_DATABASE` and `databaseSkipReason()` from Task 2.
- Produces: nothing code consumes.

Never delete `supabase/.temp/`. It holds the user's Supabase CLI link state (`pooler-url`, `linked-project.json`), and deleting it is the user's runbook step. Removing the `.gitignore` line makes it show as untracked: **never stage it**.

- [ ] **Step 1: Config cleanup**

In `tsconfig.json`, change `"exclude": ["agent", "supabase", "backend"]` to `"exclude": ["agent", "backend"]`.

In `.gitignore`, delete these two lines and the blank line after them:

```
## Supabase CLI local state
supabase/.temp/
```

Remove the Supabase platform skill and its lock entry:

```bash
git rm -r -q .agents/skills/supabase
python3 - <<'EOF'
import json
p = 'skills-lock.json'
d = json.load(open(p))
del d['skills']['supabase']
assert 'supabase-postgres-best-practices' in d['skills']
open(p, 'w').write(json.dumps(d, indent=2) + '\n')
EOF
```

Check: run `git diff skills-lock.json`. Only the `"supabase": {…}` block should be removed, with the indentation unchanged. If the original file had no trailing newline, match that.

- [ ] **Step 2: `backend/README.md`, Setup**

Replace the Setup code block:

```bash
cd backend
npm install
cp .env.example .env     # fill in DATABASE_URL + ANTHROPIC_API_KEY
npm run setup            # migrate + seed, in the right order
npm run publish -- --check   # confirms the publisher's target columns exist
```

with:

```bash
# from the repo root: Postgres (and MinIO) in docker compose. Set
# POSTGRES_PASSWORD (letters and digits) and the MINIO_ROOT_* values in the
# root .env first.
docker compose up -d postgres minio

cd backend
npm install
cp .env.example .env     # DATABASE_URL=postgres://cookmate:<password>@localhost:5432/cookmate,
                         # plus ANTHROPIC_API_KEY
npm run setup            # migrate + seed, in the right order
npm run publish -- --check   # confirms the publisher's target columns exist
```

- [ ] **Step 3: `backend/README.md`, replace the Supabase paragraph**

Replace:

```
If you are pointing at a Supabase project that already had the app tables,
`0000` is a no-op — every statement is `if not exists`.
```

with:

````
**Remote Postgres.** Any Postgres 15+ works; `DATABASE_URL` alone decides TLS
(`src/db.ts` never sets it):

- no `sslmode` — plain TCP. Right for docker compose and localhost.
- `?sslmode=verify-full` — TLS, and the server's certificate must verify.
- `?sslmode=no-verify` — TLS without checking the certificate, for a
  self-signed server.

Don't use `sslmode=require`: pg 8 treats it as `verify-full` but prints a
warning that pg 9 changes its meaning.

**Port 5432 already taken.** If Homebrew's or Postgres.app's Postgres is
running, `docker compose up postgres` fails to bind `127.0.0.1:5432` — or, if
that server started second, host-side commands quietly connect to it instead.
Stop the other server (`brew services stop postgresql@17`), or change the
compose port mapping and the port in `DATABASE_URL` to match.

**Moving from Supabase Postgres** (a fresh start, nothing is copied):

1. In the root `.env`, set `POSTGRES_PASSWORD` (letters and digits; optionally
   `POSTGRES_USER` and `POSTGRES_DB`, both default `cookmate`), then
   `docker compose up -d postgres`.
2. In `backend/.env`, set
   `DATABASE_URL=postgres://cookmate:<password>@localhost:5432/cookmate`.
3. `npm run setup` — applies every migration (including 0017, the Clerk user
   ids) and seeds the canonical dictionary.
4. `npm run dev -- storage check && npm run dev -- images --check`, then
   `npm run pipeline` and `npm run publish` to fill it again.
5. Once the app works against it, delete the Supabase CLI's local state
   (`rm -rf supabase/` from the repo root — it shows as untracked until you
   do) and pause or delete the Supabase project in its dashboard.

Favorites, shopping signals and hand-reviewed recipes that lived only in
Supabase are gone after this.
````

- [ ] **Step 4: `backend/README.md`, test and Docker sections**

Replace:

```
the suite instead of blanking a screen. `test/api.test.ts` drives real routes
via `app.inject()` and skips itself when Postgres is unreachable.
```

with:

```
the suite instead of blanking a screen. `test/api.test.ts` drives real routes
via `app.inject()`. It and `test/locks.test.ts` skip themselves when Postgres
is unreachable (`test/db-helpers.ts`), except with `REQUIRE_DATABASE=1` — set
in CI, which runs them against a Postgres service container — where an
unreachable database fails them instead.
```

In the Docker section, replace:

```bash
cp .env.example .env    # fill in DATABASE_URL, provider keys, CLERK_ISSUER,
                         # LIVEKIT_*, S3_* (MinIO), REVIEW_USERNAME/REVIEW_PASSWORD
cd .. && docker compose up --build api crawler
```

The compose file also starts MinIO; its credentials come from the root `.env`.

with:

```bash
cp .env.example .env    # fill in DATABASE_URL, provider keys, CLERK_ISSUER,
                         # LIVEKIT_*, S3_* (MinIO), REVIEW_USERNAME/REVIEW_PASSWORD
cd .. && docker compose up --build api crawler
```

The compose file also starts Postgres and MinIO; their credentials
(`POSTGRES_*`, `MINIO_ROOT_*`) come from the root `.env`. Inside compose the
`api` and `crawler` containers get their own `DATABASE_URL` pointing at
`postgres:5432`, so `backend/.env`'s localhost URL is only for host-side
commands. They wait for Postgres to be healthy, but nothing migrates on start:
run `npm run setup` once against a new database.

- [ ] **Step 5: Check no current doc or code still sends people to Supabase**

Run:

```bash
git grep -n -i supabase -- . ':!docs/' ':!backend/migrations/' ':!.agents/skills/supabase-postgres-best-practices/' ':!skills-lock.json' ':!*package-lock.json'
```

Expected: only these remain, all out of scope by the spec:
- `backend/test/storage.test.ts` (the `RAW_PAGE_STORE="supabase"` rejection test)
- `backend/test/auth.test.ts` (the "legacy Supabase path" comment)
- `lib/env.ts` (the old-client note)
- `backend/README.md`: the "Moving from Supabase Storage" runbook and the new "Moving from Supabase Postgres" runbook

Anything else is a leftover: fix it.

Note: the grep can't see `.env.example` files (they're excluded and unreadable here). Their replacement text goes in the final message.

- [ ] **Step 6: Uncommitted user files (edit, don't stage)**

In the root `README.md`, in the env table row for `backend/.env`, change `server secrets: \`DATABASE_URL\`, provider keys, service-role key` to `server secrets: \`DATABASE_URL\`, provider keys, \`S3_*\`, \`CLERK_*\``.

In its Docker section, replace:

```bash
cp backend/.env.example backend/.env   # DATABASE_URL, provider keys, CLERK_ISSUER, LIVEKIT_*,
                                        # S3_* (MinIO; credentials in the root .env),
                                        # REVIEW_USERNAME/REVIEW_PASSWORD
cp agent/.env.example agent/.env       # LIVEKIT_*
docker compose up --build
```

This starts three services: the app API (`8787`), the pipeline's operator
console (`5174`, HTTP Basic Auth via `REVIEW_USERNAME`/`REVIEW_PASSWORD`), and
the voice agent worker. See `backend/README.md#docker` for details.

with:

```bash
cp .env.example .env                   # POSTGRES_PASSWORD, MINIO_ROOT_USER/PASSWORD
cp backend/.env.example backend/.env   # DATABASE_URL, provider keys, CLERK_ISSUER, LIVEKIT_*,
                                        # S3_* (MinIO; credentials in the root .env),
                                        # REVIEW_USERNAME/REVIEW_PASSWORD
cp agent/.env.example agent/.env       # LIVEKIT_*
docker compose up -d postgres minio && (cd backend && npm run setup)   # once
docker compose up --build
```

This starts Postgres (`127.0.0.1:5432`), MinIO (`9000`, console on
`127.0.0.1:9001`), the app API (`8787`), the pipeline's operator console
(`5174`, HTTP Basic Auth via `REVIEW_USERNAME`/`REVIEW_PASSWORD`), and the
voice agent worker. See `backend/README.md#docker` for details.

In `backend/CLAUDE.md`, replace line 22, the paragraph starting `The test suite needs no database or network.`, with:

```
The test suite needs no database or network. Tests that do need Postgres (`test/api.test.ts`, `test/locks.test.ts`) get their skip reason from `databaseSkipReason()` in `test/db-helpers.ts`, which skips when `DATABASE_URL` is unset or unreachable — except under `REQUIRE_DATABASE=1` (CI, which runs a Postgres service container), where it throws. Raw-page storage falls back to the filesystem store (`RAW_PAGE_STORE=file`). Keep new database tests on that helper so CI stays honest without a database locally.
```

Then confirm none of them is staged: `git diff --cached --name-only` must not list `README.md` or `backend/CLAUDE.md`, and `supabase/` must not be staged.

- [ ] **Step 7: Run all checks**

Run: `cd backend && npm run typecheck && npm test && cd .. && npm run typecheck && npm test`
Expected: backend typecheck clean and tests pass. App typecheck clean (the `tsconfig.json` change doesn't add any files to compile) and 52 tests pass.

- [ ] **Step 8: Commit**

```bash
git add tsconfig.json .gitignore skills-lock.json backend/README.md
git commit -m "Drop the Supabase leftovers and document running on a self-hosted Postgres

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git rm` in Step 1 already staged the `.agents/skills/supabase/` deletion. Check `git show --stat HEAD` lists it, and does not list `README.md`, `backend/CLAUDE.md` or anything under `supabase/`.)

---

## Hand-off text for the final message (user pastes; the executor can't edit these)

**Root `.env.example`:** add these lines, and remove any remaining `SUPABASE` lines:

```bash
# Postgres in docker compose. The password is pasted into a URL, so letters
# and digits only.
POSTGRES_USER=cookmate
POSTGRES_PASSWORD=change-me-postgres
POSTGRES_DB=cookmate
```

**`backend/.env.example`:** replace its database block (and remove every remaining `SUPABASE` mention) with:

```bash
# Postgres. Locally this is the compose service (docker compose up -d postgres)
# with POSTGRES_PASSWORD from the root .env; the api/crawler containers get
# their own postgres:5432 URL from docker-compose.yml, so this one is for
# host-side commands. A remote server: add ?sslmode=verify-full (or
# ?sslmode=no-verify for a self-signed certificate).
DATABASE_URL=postgres://cookmate:change-me-postgres@localhost:5432/cookmate
# DB_CONNECT_TIMEOUT_MS=30000
```
