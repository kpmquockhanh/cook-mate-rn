---
id: SPEC-crawl-engine
companions:
  - current-defects.md
  - extraction-tiers.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Crawl Engine: Unstructured Extraction and Freshness

## Why

A pain to solve. The CookMate crawl engine reads only machine-readable recipe markup — schema.org JSON-LD, microdata, and a per-domain adapter registry that is currently empty. Point it at an ordinary food blog that writes its recipes as prose and it fetches the page, stores the HTML, and drops it: all three tiers miss, `parse` filters on `extracted is not null`, and nothing reaches staging. That caps the reachable corpus at the SEO-optimized long tail and makes source selection a hunt for sites that happen to emit the right `<script>` tag.

Underneath that, the engine has no concept of time. A URL that reached `done` can never be re-queued, nothing reads `locked_at` so a crash strands rows forever, no conditional request headers are stored so any future recrawl is a full re-download, and `extractionReport()` is the only observability — there is no way to tell whether last night's crawl got worse. Operators are running this by hand from a console today, which has hidden these gaps; they become blocking the moment the corpus is large enough to need maintaining rather than building.

## Capabilities

- **CAP-1**
  - **intent:** The crawler obeys robots.txt directives as written, including end-anchored patterns and correctly scoped user-agent groups.
  - **success:** A unit test suite over `robots.ts` covers `Disallow: /*.pdf$`, a group listing several consecutive `User-agent:` lines, and a group naming an agent that is merely a prefix of ours; every case resolves to the verdict the robots.txt specification requires.

- **CAP-2**
  - **intent:** The crawler holds at most one in-flight request per host, spaced by the effective crawl delay measured from request completion.
  - **success:** A test issuing concurrent fetches against one stubbed host observes no overlapping requests, and inter-request gaps of at least the configured delay, even when individual responses take longer than that delay.

- **CAP-3**
  - **intent:** The engine revisits each source on that source's own fixed schedule, so a recipe edited at its source reaches the app without an operator noticing first.
  - **success:** A source carries a recrawl interval as policy; once a URL's last fetch is older than its source's interval, the next crawl run re-queues it despite the URL having previously reached `done`. When the refetched page's content hash differs, a new `raw_pages` row is written and the recipe flows through `parse` into staging without `--force`; when it matches, nothing downstream changes.

- **CAP-4**
  - **intent:** Revisits cost near-zero bandwidth when nothing changed, and the crawler backs off for as long as a server asks it to.
  - **success:** A recrawl of unchanged pages sends `If-None-Match`/`If-Modified-Since` and records a 304 without re-downloading a body; a 429 or 503 carrying `Retry-After` delays the next request to that host by at least the stated interval.

- **CAP-5**
  - **intent:** Queue rows stranded by a crashed or killed crawl return to work on their own.
  - **success:** A row left in `fetching` past a configured lease window is reclaimed by the next crawl run and either retried or failed by the existing attempt limit; no operator action is required.

- **CAP-6**
  - **intent:** The engine extracts a recipe from a page that carries no structured markup at all, so an ordinary prose food blog becomes a publishable source.
  - **success:** Given a stored raw page from a plain-prose blog post, the engine produces an `ExtractedRecipe` with title, ingredient lines and ordered steps that the existing `parse` stage consumes unchanged, and the result reaches `recipe_staging`. Re-running it over the same stored page makes no request to the source site.

- **CAP-8**
  - **intent:** Discovery spends its fetch budget only on pages the engine has not already seen, and never discards a page it paid to fetch.
  - **success:** A second discovery run against a site already crawled skips URLs already stored rather than refetching them; every page discovery does fetch is stored regardless of whether an extractor recognised it.

- **CAP-9**
  - **intent:** Raw page storage stays bounded as the corpus grows, without losing the ability to re-extract from a page already fetched.
  - **success:** Fetched HTML lives in object storage rather than in a Postgres column, with `crawler.raw_pages` retaining the reference and the content hash; database size becomes independent of corpus HTML volume, and re-running extraction over a retained row succeeds without contacting the source site.

- **CAP-10**
  - **intent:** An operator can tell whether a crawl run performed better or worse than the last one.
  - **success:** Each run records durable per-run counters — pages fetched, HTTP status distribution, extraction outcome by tier, robots skips, failures by reason — queryable after the process exits, and the console surfaces the trend across runs.

- **CAP-11**
  - **intent:** The modules that decide politeness are covered by tests, so a regression there fails the suite rather than a source's patience.
  - **success:** `npm test` exercises `robots.ts` and `fetcher.ts` without network or database, and covers the Tier D extraction path against fixture HTML.

- **CAP-12**
  - **intent:** Gzipped sitemaps are read rather than downloaded and thrown away.
  - **success:** A site publishing only `sitemap.xml.gz` yields its URLs, and no sitemap is fetched only to be discarded for its encoding.

## Constraints

- Every extraction tier emits `ExtractedRecipe`; the deterministic `parse` stage is not modified by any capability here.
- Tier D reads pages the engine has already fetched and never requests anything from the source site, so extraction re-runs over the whole corpus without re-crawling. Reading our own object store is expected. Tier D output is version-stamped so a prompt change re-runs the corpus.
- Tier order stays cheapest-first: a paid tier runs only after the free tiers have missed, so adding one can never regress a page JSON-LD already handles.
- Discovery and crawl keep sharing one robots reader and one fetcher. A second politeness implementation is not an acceptable outcome of any capability here.
- Fetched HTML is stored once, in object storage, and referenced from `crawler.raw_pages`. No capability may reintroduce HTML as a Postgres column.
- `crawler.raw_pages` stays append-only; freshness is expressed as new rows keyed by content hash, never as edits to an existing row.
- Recrawl cadence is per-source policy on `crawler.sources`, alongside `crawl_delay_ms` and `allow_image_use` — not a global setting and not derived from sitemap `lastmod`.
- `crawler.sources.allow_image_use` keeps defaulting to false, and no new code path may set it.
- Per-page LLM cost is opt-in or budgeted per source, never the default path for every crawl.
- Pipeline state stays in Postgres and object storage; jobs stay in-process and disposable.
- The app's published schema is fixed — `publish/mapping.ts` is not touched.

## Non-goals

- Rendered-page fetching for JavaScript-built recipe pages. Deferred out of this spec; the reserved shape is documented as Tier E in `extraction-tiers.md`, and no source flag, image dependency, or code path for it is built here.
- A distributed or multi-machine crawler. Single-process with `FOR UPDATE SKIP LOCKED` remains the concurrency model.
- Bypassing paywalls, login walls, or anti-bot measures.
- Acting as a general-purpose web archive. Raw HTML retention is bounded on purpose.
- Replacing the deterministic `parse` stage with an LLM. Tier D produces the same shape the free tiers do and stops there.
- Changing the app's published tables or the RN client.

## Success signal

An operator points `discover` at a food blog that writes its recipes in plain prose, with no schema.org markup anywhere on the site, and ends the run with publishable recipes in the review queue. A week later the source's recrawl interval comes due on its own: the run completes in a fraction of the bandwidth, touches only the pages that genuinely changed, and its counters sit next to the previous run's so the difference is visible without reading logs.

## Assumptions

- Object storage means Supabase Storage, since the project already depends on Supabase for auth and the app tables. No separate provider is assumed.
- Single-process crawling remains sufficient for the corpus sizes in view; nothing here is sized for a fleet.
- The existing operator console remains the primary interface, so every capability is expected to be reachable from it as well as from the CLI.
- Tier D quality will be below the structured tiers, so its output is expected to need human triage more often than tier A's.

## Open Questions

- Which model and what per-page budget cap for Tier D, and should Tier D output route straight to `review` rather than being eligible for `approved`?
