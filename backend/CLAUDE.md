# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is the `backend/` package of CookMate: a standalone npm package (own `package.json`, lockfile, `.env`) holding the recipe pipeline and the REST API the Expo app reads. `README.md` here is detailed and authoritative on operating the pipeline — read the relevant section before changing a stage.

## Commands

```bash
npm test                          # tsx --test test/*.test.ts (node:test, not Jest)
npx tsx --test test/parse.test.ts # one file
npx tsx --test --test-name-pattern 'fractions' test/parse.test.ts
npm run typecheck
npm run api:dev                   # API on :8787, restarts on change
npm run ui                        # operator console on :5174; refuses to start without REVIEW_USERNAME/REVIEW_PASSWORD
npm run dev -- <command> [flags]  # any src/cli.ts command; `npm run dev` alone prints usage
npm run setup                     # migrate + seed canonical ingredients
```

Everything runs through `tsx`; there is no compiled build (the Docker image runs the same way). CI runs only `npm run typecheck` and `npm test` here.

The test suite needs no database or network. Tests that do need Postgres (`test/api.test.ts`, `test/locks.test.ts`) get their skip reason from `databaseSkipReason()` in `test/db-helpers.ts`, which skips when `DATABASE_URL` is unset or unreachable — except under `REQUIRE_DATABASE=1` (CI, which runs a Postgres service container), where it throws. Raw-page storage falls back to the filesystem store (`RAW_PAGE_STORE=file`). Keep new database tests on that helper so CI stays honest without a database locally.

## Conventions

- ESM with `module: NodeNext`: relative imports must use the `.js` extension (`import { query } from './db.js'`), even from `.ts` files. `strict` and `noUncheckedIndexedAccess` are on.
- Database access is raw SQL through `query` / `one` / `transaction` in `src/db.ts` (node-postgres pool; NUMERIC and INT8 are parsed to `number`). No ORM.
- Configuration goes through the `env` object in `src/env.ts` (getters, so tests can change `process.env` between calls). Add new variables there and to `.env.example` — the root `npm run env:check` flags drift.
- Logging goes through `logger(scope)` from `src/log.ts`. It uses AsyncLocalStorage so console jobs and stored crawl-run logs capture the lines of whatever they run; don't `console.log` from stages.
- Schema changes are new numbered files in `migrations/` (`NNNN_name.sql`). `src/migrate.ts` applies every pending file in its own transaction and records it in `crawler.schema_migrations`; never edit an applied migration. The app-facing tables are `public.*`; everything the pipeline owns is in the `crawler` schema.

## Architecture

### Pipeline

```
discover → crawl_queue → crawl (tiers A/B/C) → raw_pages ─┬→ parse → recipe_staging → enrich → gate → images → publish → public.* → translate
                                                          └→ extract (tier D, LLM) ┘
```

- `src/cli.ts` is the single entry point: each stage is a command, and `pipeline` runs crawl → extract → parse → enrich → gate → images (it stops before publish). The console (`src/ui/server.ts` + `src/ui/public/`) calls the same functions through the in-memory job runner in `src/jobs/runner.ts` — keep stage logic in the stage modules so both paths stay identical.
- Stages that must not overlap take Postgres advisory locks via `withJobLock` (`src/jobs/locks.ts`); `pipeline` holds the locks of every stage it covers. A new stage that writes shared rows should take a lock too.
- `raw_pages` is immutable, and the HTML lives gzipped and content-addressed in object storage (`src/storage/`), not in Postgres. Re-running a stage with a changed prompt or parser works over stored pages: bump `ENRICHMENT_VERSION` / `EXTRACTION_VERSION` / `TRANSLATION_VERSION` (env settings read in `src/env.ts`) instead of recrawling.
- Crawl runs, extract runs and discover runs record counters in `crawler.crawl_runs` and their log lines in `crawler.crawl_run_logs` (`src/jobs/runs.ts`).
- `parse` is deterministic (no LLM). `enrich`, `extract` and `translate` call an LLM through a provider abstraction in `src/enrich/providers/` (`anthropic` or `deepseek`, selected by `ENRICH_PROVIDER`). Structured output is validated with zod schemas (`src/enrich/schema.ts`, `src/translate/schema.ts`). `env.ts` rejects a model override whose prefix doesn't match the provider.
- `translate` runs after `publish` (and automatically at the end of it). It reads `public.*`, not staging, because its overlays are keyed on published `sort_order` and `content_fingerprint`.

### Rules the pipeline depends on
- Step→ingredient links are **indices** into the ingredient array, validated by `sanitize()` in `src/enrich/llm.ts`. The publisher writes back the exact `ingredient_text` strings because the app matches on them.
- Timer durations are for unattended waiting only. A range takes the upper bound, and anything outside 30s–8h is discarded.
- Images are only mirrored (`images`) or published when the source's `crawler.sources.allow_image_use` is true. It defaults to false.
- Tier D (LLM-extracted) recipes always go to `review` at the gate, whatever their score. Tier D extraction must be grounded: every ingredient must appear in the page text.
- Canonical ingredient matching is deliberately conservative (below 0.78 similarity a row stays unmatched). The dictionary is `seed/canonical-ingredients.json`.
- Crawling honours robots.txt, per-host `Crawl-delay` and `Retry-After` (applied to the whole host). Don't add fetch paths that bypass `src/crawl/fetcher.ts`.

### API (`src/api/`)
- Fastify. `buildServer` in `server.ts` is also what tests use, through `app.inject()` with no port.
- Auth: `registerAuth` installs a root `onRequest` hook that verifies Clerk session tokens locally (RS256 JWKS at `${CLERK_ISSUER}/.well-known/jwks.json`; `azp` checked against `CLERK_AUTHORIZED_PARTIES` for web tokens). `user_id` columns are text holding Clerk ids. It must be registered **before** the routes, or routes registered earlier are silently unauthenticated. Only `PUBLIC_ROUTES` in `auth.ts` skip it. Handlers get the caller with `requireUser(request)`. `POST /voice/token` (`src/api/routes/voice.ts`) mints LiveKit tokens and needs `LIVEKIT_*`; object storage is S3/MinIO via `src/storage/s3.ts` (`S3_*`).
- Responses are wrapped as `{ data }` (the app's `lib/api.ts` unwraps them). A 401 body carries `reason`.
- `orderBy` resolves through the `ORDER_BY` allowlist in `schema.ts`; never interpolate client input into SQL. `limit` caps at 200, because the app's pagination depends on it.
- Table and column names shared by the publisher and the API live only in `src/publish/mapping.ts`. `test/api-contract.test.ts` diffs the API's selected columns against it, and `npm run publish -- --check` checks them against a live database.
