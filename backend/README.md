# CookMate backend

Two halves of one service:

- **The pipeline** turns arbitrary web recipes into **cooking-mode-ready** data:
  per-step timers, step↔ingredient links, and canonical ingredients the shopping
  list can merge.
- **The API** (`src/api`) serves what the pipeline publishes to the RN app at
  `EXPO_PUBLIC_API_URL`.

They share `src/db.ts`, `src/env.ts` and `src/log.ts`, and deploy as one
package.

Crawling is the easy 30%. The app needs `instructions[].duration`,
`.timerName`, and `.ingredients[]` — fields **no source on the internet
publishes** — so enrichment is where most of the value is.

## Setup

```bash
cd backend
npm install
cp .env.example .env     # fill in DATABASE_URL + ANTHROPIC_API_KEY
npm run setup            # migrate + seed, in the right order
npm run publish -- --check   # confirms the publisher's target columns exist
```

`npm run setup` is `npm run migrate` followed by `npm run seed`; run them
separately if you prefer. Both are idempotent, so re-running after you extend a
migration or the seed file is safe.

Migrations, in order:

| File | What it creates |
|------|-----------------|
| `0000_app_schema.sql` | The five `public.*` tables the app reads, plus RLS (public read) |
| `0001_crawler_core.sql` | The `crawler` schema: sources, queue, raw pages, staging |
| `0002_canonical_ingredients.sql` | The canonical ingredient dictionary |
| `0003_app_provenance.sql` | Provenance columns on `public.recipes`, the `url_hash` unique index, canonical links on ingredients |
| `0004_url_hash_unique.sql` | Makes the `url_hash` index non-partial so `on conflict` can infer it |
| `0005_ai_score.sql` | The model's own 0–10 score on `public.recipes` |
| `0006_raw_pages_storage.sql` | `raw_pages.storage_path` — the reference to the page's bytes in object storage |
| `0007_drop_raw_page_html.sql` | Drops `raw_pages.html`. **Refuses to run** while any page still holds HTML that has not been moved |
| `0008_llm_extraction.sql` | Version stamp and model for Tier D extraction |
| `0009_freshness.sql` | Per-source recrawl interval, plus HTTP validators on the crawl queue |
| `0010_crawl_runs.sql` | `crawler.crawl_runs` — per-run counters that outlive the process |
| `0011_crawl_run_logs.sql` | `crawler.crawl_run_logs` — the lines a run produced, stored as it goes |

### Where crawled HTML lives

There are two buckets: `raw-pages` is **private** and holds gzipped crawled
HTML, and `recipe-images` is **public** and holds mirrored recipe photos, which
the app loads straight from an `<Image>` with no session. `npm run dev -- images
--check` creates the second one and prints the exact URL the app's
`EXPO_PUBLIC_STORAGE_URL` must be set to.


Pages are kept in object storage (Supabase Storage, the same project as auth and
the app tables), not in a Postgres column. `raw_pages` holds the reference and
the content hash. They are **content-addressed and gzipped**, so the same HTML
reached by two URLs is stored once and re-storing an unchanged page overwrites
itself.

```bash
npm run dev -- storage check        # is it reachable? creates the bucket if not
```

Set `SUPABASE_SERVICE_ROLE_KEY` for this — the service role, not the publishable
key, because the bucket is private. For local work with no Supabase project, set
`RAW_PAGE_STORE=file` and pages go to `RAW_PAGE_DIR` on disk instead.

**Upgrading a database that predates this**, HTML still in the column:

```bash
npm run migrate                       # 0006 lands; 0007 stops and tells you this
npm run dev -- storage backfill       # move the bytes; resumable, idempotent
npm run migrate                       # 0007 now drops the column
```

The guard in 0007 is deliberate. `migrate` applies every pending file in one
invocation, so without it a single `npm run migrate` would add the reference
column and drop the HTML in the same breath, destroying every page not yet
moved. Each migration runs in its own transaction, so the failure leaves 0006
applied and costs you one extra command.

`publish --check` is the important one: this repo does not contain the backend
that serves `EXPO_PUBLIC_API_URL`, so the publisher's table/column names are
**inferred** from what the RN app reads. They all live in `src/publish/mapping.ts`
and nowhere else. The check introspects your live database and names every
table or column that is missing.

If you are pointing at a Supabase project that already had the app tables,
`0000` is a no-op — every statement is `if not exists`.

## Running it

The console is the short path — `npm run ui` opens an operator UI at
localhost:5174 that does everything below from a browser: point it at a site,
watch it find the recipes, run each stage, and triage what comes out with a live
log of what is happening.

```bash
npm run ui                                      # the whole pipeline, in a browser
```

It is protected by HTTP Basic Auth — set `REVIEW_USERNAME`/`REVIEW_PASSWORD` in
`.env` first, or it refuses to start (see [The console](#the-console)).

Everything it does is also a command, because the console calls exactly the same
functions the CLI does:

```bash
npm run discover -- https://example.com         # explore a site, queue what it finds
npm run enqueue -- https://example.com/recipe   # or @urls.txt, one per line
npm run dev -- sources                          # per-domain crawl/licence policy
npm run pipeline -- --limit 50                  # crawl → parse → images → enrich → gate
npm run publish -- --limit 50                   # approved rows → app tables
npm run dev -- images --check                   # create the image bucket, print the app's STORAGE_URL
```

### Finding recipes without a URL list

`discover` takes one link — a homepage, a category page, whatever you have — and
works out the recipe URLs itself:

```bash
npm run discover -- https://example.com --dry-run          # look, write nothing
npm run discover -- https://example.com --max-pages 80     # then do it for real
npm run discover -- https://example.com --exclude '/(tag|author)/'
```

It reads the site's own sitemap when there is one (`Sitemap:` in robots.txt, or
the usual paths, gzipped or not), and otherwise walks links from the seed,
preferring pages that might be recipes over navigation so the fetch budget is
not spent on "About". Three things keep it honest:

- **It is bounded.** `--max-pages` is a hard fetch budget, `--depth` limits how
  far from the seed it will walk, `--max-results` caps what it returns.
- **It is as polite as the crawler**, because it *is* the crawler: the same
  robots.txt reader, the same per-host `Crawl-delay`, the same user agent.
- **It never pays for the same page twice.** A page already in `raw_pages` is
  read from there instead of refetched — a hub walked last week still has the
  links this walk needs. `--refetch` overrides that when seeing the page again
  is the point.

**Every page discovery downloads is kept**, not just the ones that turn out to
be recipes. A page fetched as a candidate gets a `crawl_queue` row recording how
it turned out; a hub, read only for its links, is stored without one. Keeping
the misses is what lets a better extractor be run over them later without asking
the source for those bytes a second time. URLs it is confident about from their
shape alone are queued without a fetch, for `crawl` to pick up.

**If published recipes come back without images**, that is the source policy
doing its job, not a crawl failure — the photos are in `recipe_staging`, and
`publish` withheld them because `allow_image_use` is false. Record the licence
check and rewrite the rows you already published:

```bash
npm run dev -- sources set example.com --allow-images --name "Example" --license "CC BY 4.0"
npm run publish -- --republish                  # also rewrites status='published' rows
```

Each stage is also a standalone command (`crawl`, `extract`, `parse`, `enrich`,
`gate`) and a button in the console.

### Keeping the corpus fresh

Sources change their recipes, and a crawler that only ever fetches a URL once
never finds out. Every source carries a revisit interval — 30 days by default,
per-source, set in hours and thought about in days:

```bash
npm run dev -- sources set example.com --recrawl-days 7
npm run dev -- sources set example.com --no-recrawl     # never revisit
```

`crawl` does the rest, and three things keep it from being expensive:

- **It is bounded by the same `--limit` as the crawl it precedes**, so a large
  corpus coming due at once does not turn one run into a full re-crawl.
  Refreshes also take a worse priority than new URLs — finding something new
  beats re-reading something you have.
- **Unchanged pages cost a 304 and no body.** The `ETag` and `Last-Modified` a
  source gave last time are sent back as `If-None-Match` / `If-Modified-Since`.
  A 304 writes no new page and redoes nothing downstream.
- **A changed page flows through on its own.** A new `raw_pages` row appears
  beside the old one, `parse` picks it up without `--force`, and the enrichment
  describing the old steps is cleared — its timers and step→ingredient indices
  pointed into an array that no longer exists.

`crawl` also takes back rows stranded in `fetching` by a killed run, once they
are past `CRAWL_LOCK_LEASE_MINUTES` (15 by default). And when a source answers
429 or 503 with `Retry-After`, **the whole host** waits that long — not just the
request that was refused.

### Did last night's crawl get worse?

`crawl`, `extract` and `discover` each record a row in `crawler.crawl_runs`:
what they were asked to do, and counters for what happened — pages fetched, the
HTTP status distribution, which extractor tier won, robots skips, and failures
split by reason. Counters are flushed while the run is still going, so a run
that dies still leaves its numbers behind.

```bash
npm run dev -- runs                      # last 10 runs, all kinds
npm run dev -- runs --kind crawl --limit 20
npm run dev -- runs --log 21             # the log run #21 stored, oldest first
```

It prints a matrix — counters down, runs across, oldest on the left:

```
counter               #12     #15     #18     #21
pages_fetched          50      50      50      48
http_200               48      47      31      12
http_304                0       0      17      34
failed_no_markup        2       3      19       2
```

That shape is the point. A block of numbers per run hides a trend; side by side,
`failed_no_markup` going 2 → 3 → 19 is impossible to miss, and `http_304`
climbing is the revisit machinery doing its job. A dash means the counter did
not exist for that run, which is not the same as counting zero.

The console's **Runs** tab shows the same matrix with per-run deltas. Clicking a
run opens the log it stored.

### The log a run left behind

Counters say a run went worse; only the lines say which URLs did it. So the log
is stored with the run rather than streamed at whoever is watching: every line a
`crawl`, `extract` or `discover` emits is written to `crawler.crawl_run_logs` as
it goes — about a second behind live — and is still there after the run ends,
after the console is closed, and after the process restarts. A run that crashes
keeps the lines leading up to it, because the buffer is drained before the row
is marked failed.

Read one with `npm run dev -- runs --log <id>`, or from the console: the drawer
follows the stored log of whatever stage it is watching, and the Runs tab opens
any past run's log. A run is capped at 20,000 stored lines; past that the
overflow is counted in the run's own `log_lines_dropped` counter rather than
silently thrown away.

Lines still go to stdout as always, so `docker logs` and a terminal-run crawl
are unchanged.

`npm run crawl -- --robots-check` re-evaluates everything already queued against
the current robots.txt rules and prints what is now disallowed, grouped by
domain, flagging any it had already fetched. It writes nothing — it is there so
a change in how robots.txt is read shows up as a list rather than as URLs
quietly disappearing from the next crawl.

## Docker

The `api` and `ui` (console) commands both run from `backend/Dockerfile`; see
the repo root `docker-compose.yml` for how each service uses it, and the
[voice agent's own image](../agent) for the third service it starts.

```bash
cp .env.example .env    # fill in DATABASE_URL, provider keys, SUPABASE_URL,
                         # REVIEW_USERNAME/REVIEW_PASSWORD
cd .. && docker compose up --build api crawler
```

The image installs `devDependencies` too and runs via `tsx`, matching how the
package.json scripts already run — there's no separate compiled build. The
`crawler` service sets `REVIEW_HOST=0.0.0.0` so its published port is
reachable; that is only safe because the console refuses to start without
`REVIEW_USERNAME`/`REVIEW_PASSWORD` set.

## The API

```bash
npm run api        # serve on :8787
npm run api:dev    # same, restarting on change
```

| Route | Auth | Notes |
|-------|------|-------|
| `GET /health` | public | Runs `select 1`; use it as a container healthcheck |
| `GET /recipes` | required | Search: `search`, `category`. Facets: `meal`, `mainIngredient`, `diet`, `difficulty`, `cuisine`, `maxMinutes`, `maxActiveMinutes`, `handsOff`. Lists: `popular`, `favorites`. Paging: `orderBy`, `order`, `limit`, `offset` |
| `GET /recipes/:id` | required | Full detail with images, ingredients, instructions and notes. 404 when absent |
| `PUT /recipes/:id/favorite` | required | Saves it for the caller. Idempotent |
| `DELETE /recipes/:id/favorite` | required | Unsaves it. Idempotent |
| `POST /recipes/:id/events` | required | `{ kind: 'viewed' \| 'started' \| 'completed' }`. 204, and what `popular` counts |

All but the events route return `{ data: ... }`.

Every row carries `is_favorite` for the caller and `cook_count` for the last 30
days. `popular` orders by completed cooks — real usage of this app, not the
scraped `rating`, which is 5.00 on most rows because sites keep what their
readers liked.

### Authentication

Every route except `/health` requires the caller's Supabase access token:

```
Authorization: Bearer <session.access_token>
```

The app gets this for free — `lib/api.ts` attaches the token and retries once on
a 401 against a refreshed session. For curl, take a token from a signed-in
session or mint one for a seeded user (`npm run seed:auth`).

The token is verified **locally** (`src/api/auth.ts`): signature, `iss`,
`aud: authenticated` and expiry. There is no call to the auth server on the
request path. Two signing schemes are accepted, resolved from the token header,
so a project can rotate from one to the other without dropping live sessions:

```bash
SUPABASE_URL=https://PROJECT.supabase.co  # JWKS for ES256/RS256 keys + expected issuer
SUPABASE_JWT_SECRET=...                   # only if the project still signs HS256
```

With neither set the API **refuses to start** rather than serving unauthenticated.

A 401 body carries a `reason`: `missing_token`, `invalid_token`, or
`token_expired`. Only the last one is worth retrying — it means refresh and try
again, not sign the user out.

The guard is a root-level `onRequest` hook registered before the routes, so a new
route is authenticated by default. Making one public is a deliberate edit to
`PUBLIC_ROUTES` in `src/api/auth.ts`, and route handlers read the caller from
`request.user` (`requireUser(request)` narrows it).

Other optional `.env` settings (defaults shown):

```bash
API_PORT=8787
API_HOST=0.0.0.0        # so a phone on the LAN can reach it
API_CORS_ORIGIN=*       # set your web origin explicitly in production
```

Three things worth knowing before you extend it:

- **`orderBy` is client input.** It resolves through the `ORDER_BY` allowlist in
  `src/api/schema.ts` and is never interpolated. Add sortable columns there.
- **`limit` caps at 200, not 100.** `app/(tabs)/all-recipes.tsx` paginates by
  requesting `ITEMS_PER_PAGE * page`, and the client infers "more pages exist"
  from `rows.length >= limit`. Cap it below what that reaches and the list stops
  loading partway down.
- **`featured` and `popular` are derived**, not columns. `popular` sorts by
  rating then review count; `featured` by the `quality_score` the gate stage
  computes. Swap in an `is_featured` column when you want editorial control.

`test/api-contract.test.ts` diffs the columns the API selects against
`src/publish/mapping.ts` and needs no database, so a rename on either side fails
the suite instead of blanking a screen. `test/api.test.ts` drives real routes
via `app.inject()` and skips itself when Postgres is unreachable.

## Architecture

```
crawl_queue → raw_pages → recipe_staging → public.recipes
              (immutable)  (parse/enrich/gate)
```

Stages are separate tables on purpose. When you improve the enrichment prompt
you bump `ENRICHMENT_VERSION` and re-run `enrich` over **stored raw pages** —
no re-crawling the internet.

| Stage | Command | What it does |
|---|---|---|
| 0 Crawl | `crawl` | robots.txt + per-host rate limit, conditional requests, then tier A→B→C extraction. HTML to object storage, reference to `raw_pages` |
| 0.5 Extract | `extract` | Tier D: a model reads recipes off stored pages tiers A/B/C could not. Network-free. |
| 1 Parse | `parse` | Deterministic: quantities, units, grams, step segmentation, canonical matching. No LLM. |
| 1.5 Images | `images` | Downloads each recipe's photos into our own **public** Supabase bucket, so the app serves copies we hold instead of hotlinking. Skips any source without `allow_image_use`. |
| 2 Enrich | `enrich` | One Claude call per recipe: durations, timer names, step↔ingredient indices, meal, cuisine |
| 3 Gate | `gate` | Score 0–100, dedupe by fingerprint, route to `approved` / `review` / `rejected` |
| 4 Publish | `publish` | Writes the app's exact wire shape, including the facets it derives (meal, hands-on time, main ingredient, diet); idempotent on `url_hash` |

Stage 0 has a step in front of it that is optional but usually what you want:

| Stage | Command | What it does |
|---|---|---|
| — Discover | `discover` | One seed URL → many recipe URLs, via sitemap or a bounded link walk |

### The console

`npm run ui` serves `src/ui/` on `REVIEW_PORT` (5174 by default): tabs for the
crawl queue (which is also where URLs get in, either pasted as a list or found
by exploring a site), per-domain source policy, the review queue and unmatched
ingredients, plus a stage runner with a live log.

Stage runs become **jobs** (`src/jobs/runner.ts`): they run in-process, stream
their log lines to the page, and can be cancelled. Only one job per stage runs at
a time, because two `crawl` runs would race for the same queue rows and two
`enrich` runs would spend the model budget twice on the same staging rows. Jobs
live in memory only — the pipeline's real state is in Postgres, so a restart
costs you a job list and nothing else.

The log in the drawer is read from the database for any stage that records a run
(`crawl`, `extract`, `discover`), which is why closing the tab or restarting the
console no longer loses it. `pipeline` spans several runs plus stages that
record none, so no single stored log is its log and it keeps the in-memory
buffer; each stage inside it still stores its own.

The console **binds to 127.0.0.1 by default and requires HTTP Basic Auth**
(`REVIEW_USERNAME`/`REVIEW_PASSWORD`) on every request — it refuses to start
without them, since anyone who can reach it can start crawls and spend model
budget. `REVIEW_HOST` controls the bind address; only set it to something
other than `127.0.0.1` (as the Docker image does — see [Docker](#docker))
once real credentials are in place.

### Extraction tiers

| Tier | Method | Coverage | Cost |
|---|---|---|---|
| A | `schema.org/Recipe` JSON-LD | ~80% of recipe sites | free |
| B | Microdata / RDFa | +10% | free |
| C | Per-domain adapter | the long tail | free, high maintenance |
| D | A model reading the page as prose | everything else | **per page** |

Tiers A–C read structure a page publishes about itself. **Tier D reads the page
the way a person would**, which is what makes an ordinary food blog — recipes in
plain prose, no markup anywhere — a usable source. It runs only when A, B and C
have all missed, over pages already stored, so it never touches the network:

```bash
npm run extract -- --limit 50 --dry-run   # see what it would find, spend nothing
npm run extract -- --limit 50
```

Three things keep it honest:

- **It can say no.** A category listing, a round-up of links or an essay about a
  dish returns "not a recipe", and that verdict is recorded so the next run does
  not pay to reach it again.
- **It has to be grounded.** Every ingredient line is checked back against the
  page's own text. A well-formed recipe for a dish the page never mentions is
  discarded — that is the failure a schema cannot catch.
- **It is budgeted.** `EXTRACT_MAX_PAGES_PER_RUN` caps a run regardless of
  `--limit`, listing-shaped URLs are skipped before any call is made, and
  `EXTRACT_MAX_CHARS` bounds what one page can cost.

Bump `EXTRACTION_VERSION` to re-read the whole backlog with a changed prompt —
the same lever `ENRICHMENT_VERSION` is for the stage after it, and like it, no
source is crawled again.

**Tier D recipes never publish on score alone.** The gate routes them to
`review` even at a passing score: a misread quantity looks exactly like a
correct one, so a person sees it first.

Adapters are maintenance debt — their selectors break on every redesign. Only
write one when `npm run crawl -- --report` shows a domain you care about
repeatedly defeating A and B. Copy `src/crawl/adapters/example-template.ts`
and import it from `adapters/index.ts`.

## Two design decisions worth knowing

**Step→ingredient links are indices, not strings.** `app/cooking/[id].tsx:140`
currently substring-matches step ingredients against `ingredient_text`. That
fails silently whenever the model paraphrases. The LLM returns positions into
the ingredient array, `sanitize()` in `src/enrich/llm.ts` validates every index
against that array, and the publisher writes back the *exact* `ingredient_text`
strings so the app's existing matcher can't miss.

**Durations are unattended waiting only.** "Chop the onion" gets no timer even
when the source states a time for it, or Cooking Mode fills with timers nobody
wants. Ranges take the upper bound — undercooked is the worse failure. Anything
outside 30s–8h is discarded as a model slip.

## Legal posture

- `robots.txt` is honoured, with per-host `Crawl-delay` and a contactable UA.
- Ingredient lists and functional instructions are generally not copyrightable
  in the US; **photos and surrounding prose are**.
- Images are only **downloaded or republished** when `crawler.sources.allow_image_use`
  is true — it defaults to **false** on every auto-created source. Set it per
  source with `sources set <domain> --allow-images` once you have checked the
  licence. This is the usual reason a crawl looks like it "came back without
  images": the photos are in `recipe_staging.image_urls`, and both the mirror
  stage and the publisher decline to use them.
- Mirroring stores a **copy** of a photo, which is a bigger step than linking
  one. Check the licence before turning a source on, not after.
- `source_url` / `source_name` / `source_license` ride along to every published
  recipe so attribution is always available.

None of this is legal advice. For the seed 100 the PRD asks for, permissively
licensed sources (TheMealDB, USDA, Wikibooks Cookbook) avoid the question.

## Growing the canonical dictionary

This is the single highest-leverage manual task — without it the shopping list
can't merge "2 cloves garlic" with "1 tsp minced garlic".

```bash
npm run dev -- unmatched      # ranked by how often each string appeared
```

Add the top entries to `seed/canonical-ingredients.json`, re-run `npm run seed`,
then re-run `parse --force`. Matching is deliberately conservative: below 0.78
similarity a row is left unmatched rather than guessed, because a wrong
canonical link silently corrupts every shopping list it touches.

## Tests

```bash
npm test          # unit tests; no DB or network needed
npm run typecheck
```
