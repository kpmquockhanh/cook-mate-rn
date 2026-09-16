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

`publish --check` is the important one: this repo does not contain the backend
that serves `EXPO_PUBLIC_API_URL`, so the publisher's table/column names are
**inferred** from what the RN app reads. They all live in `src/publish/mapping.ts`
and nowhere else. The check introspects your live database and names every
table or column that is missing.

If you are pointing at a Supabase project that already had the app tables,
`0000` is a no-op — every statement is `if not exists`.

## Running it

```bash
npm run enqueue -- https://example.com/recipe   # or @urls.txt, one per line
npm run dev -- sources                          # per-domain crawl/licence policy
npm run pipeline -- --limit 50                  # crawl → parse → enrich → gate
npm run review                                  # triage at localhost:5174
npm run publish -- --limit 50                   # approved rows → app tables
```

**If published recipes come back without images**, that is the source policy
doing its job, not a crawl failure — the photos are in `recipe_staging`, and
`publish` withheld them because `allow_image_use` is false. Record the licence
check and rewrite the rows you already published:

```bash
npm run dev -- sources set example.com --allow-images --name "Example" --license "CC BY 4.0"
npm run publish -- --republish                  # also rewrites status='published' rows
```

Each stage is also a standalone command (`crawl`, `parse`, `enrich`, `gate`).

## The API

```bash
npm run api        # serve on :8787
npm run api:dev    # same, restarting on change
```

| Route | Notes |
|-------|-------|
| `GET /health` | Runs `select 1`; use it as a container healthcheck |
| `GET /recipes` | `search`, `category`, `featured`, `popular`, `orderBy`, `order`, `limit`, `offset` |
| `GET /recipes/:id` | Full detail with images, ingredients, instructions and notes. 404 when absent |

Both return `{ data: ... }`.

Add these to your `.env` (they are optional — the defaults below apply):

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
| 0 Crawl | `crawl` | robots.txt + per-host rate limit, then tier A→B→C extraction |
| 1 Parse | `parse` | Deterministic: quantities, units, grams, step segmentation, canonical matching. No LLM. |
| 2 Enrich | `enrich` | One Claude call per recipe: durations, timer names, step↔ingredient indices |
| 3 Gate | `gate` | Score 0–100, dedupe by fingerprint, route to `approved` / `review` / `rejected` |
| 4 Publish | `publish` | Writes the app's exact wire shape; idempotent on `url_hash` |

### Extraction tiers

| Tier | Method | Coverage |
|---|---|---|
| A | `schema.org/Recipe` JSON-LD | ~80% of recipe sites |
| B | Microdata / RDFa | +10% |
| C | Per-domain adapter | the long tail |

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
- Images are only republished when `crawler.sources.allow_image_use` is true —
  it defaults to **false** on every auto-created source. Set it per source with
  `sources set <domain> --allow-images` once you have checked the licence.
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
npm test          # 14 unit tests, no DB or network
npm run typecheck
```
