# Extraction tiers

## Current model

`extractRecipe(html, url)` in `src/crawl/extract.ts` tries tiers in a fixed order and returns the first hit, together with the name of the tier that won. That name is stored in `raw_pages.extractor`, which is what `extractionReport()` aggregates.

| Tier | Method | Requires | Cost |
|---|---|---|---|
| A | `schema.org/Recipe` JSON-LD | A `<script type="application/ld+json">` block | Free, local |
| B | Microdata / RDFa | `itemtype="schema.org/Recipe"` in the DOM | Free, local |
| C | Per-domain adapter | A hand-written selector set per domain; registry is empty | Free, local; high maintenance |

All three read the HTML the fetcher already has. None can read prose.

## Target model

One tier is added. The ordering rule is unchanged and load-bearing: cheapest first, so a paid tier can never regress a page a free tier already handles well.

| Tier | Method | Trigger | Cost |
|---|---|---|---|
| A | JSON-LD | always first | free |
| B | Microdata / RDFa | A missed | free |
| C | Per-domain adapter | A and B missed, adapter registered for the domain | free |
| **D** | **LLM over an already-fetched page** | **A, B and C all missed** | **per page, metered** |

```
fetch ──► object storage (HTML) + raw_pages (reference, content hash)
             │
             ├─► A  JSON-LD ──┐
             ├─► B  microdata ┤
             ├─► C  adapter ──┤──► ExtractedRecipe ──► parse ──► staging
             └─► D  LLM ──────┘
```

## Tier D contract

- **Input is a page the engine already fetched, never a live source URL.** Tier D must be runnable as a batch over the corpus without contacting any source site, exactly as `enrich` is today. Reading our own object store to get the HTML back is expected and permitted. This is what makes the pages currently sitting in `raw_pages` with `extracted = null` recoverable without re-crawling their sources.
- **Output is `ExtractedRecipe`** — the same type tiers A–C produce, defined in `src/types.ts`. `parse` must not learn that tier D exists.
- **Version-stamped.** The result carries the extraction version it was produced under, and the selection query picks up rows stamped below the current version. Improving the prompt re-runs the corpus; it does not re-crawl the internet. `enrich/run.ts:24-33` is the pattern to copy.
- **Never invents.** The same discipline as `enrich/llm.ts`: ingredient lines and steps must be present in the source HTML. A recipe the page does not contain is worse than no recipe, because the gate cannot tell the difference.
- **Metered.** Per-page cost means tier D needs a budget ceiling per run, and a source-level opt-out for domains known to be junk.

## Tier E — reserved, deferred

Rendered-page fetching for JavaScript-built recipe pages is **out of scope** (see Non-goals in SPEC.md). Nothing here is built: no source flag, no headless browser in the backend image, no code path. The shape is recorded so the slot is reserved rather than rediscovered later.

Tier E would sit outside the local extraction chain because it is a *fetch* strategy, not an extraction strategy: it produces different HTML, which then goes through A→D normally. Were it picked up, it would be gated by a per-source flag defaulting off, would produce an ordinary stored page with its own content hash so freshness and re-extraction need no special cases, and would obey the same robots reader and per-host gate as every other fetch — rendering changes what a fetch costs, not what a fetch is allowed to do.

## What stays out

- Tier C is not deleted. It remains the right answer for a high-volume domain where a selector set is cheaper and more reliable than a per-page LLM call. `crawl --report` remains how a domain earns one.
- No tier writes directly to `recipe_staging`. Every tier stops at `ExtractedRecipe` and hands over to `parse`.
