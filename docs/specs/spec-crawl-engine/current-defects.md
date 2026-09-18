# Current defects and gaps

Read against `backend/` at commit `37bd685`. Each entry names the capability it belongs to in SPEC.md. Line numbers are where the behaviour lives, not necessarily where the fix goes.

## Correctness defects

| # | Location | Behaviour | CAP |
|---|---|---|---|
| 1 | `src/crawl/robots.ts:75-79` | `$` is escaped into a literal by the character class on line 75, and both branches of the ternary on line 78 produce the same string, so the end-anchor is dead. `Disallow: /*.pdf$` matches nothing. | CAP-1 |
| 2 | `src/crawl/robots.ts:59` | `env.userAgent.toLowerCase().startsWith(agent)` means a group declared for `User-agent: c` claims `CookMateBot/1.0`. Matching should be on the product token, not a prefix of the full UA string. | CAP-1 |
| 3 | `src/crawl/robots.ts:57-61` | `applies` is reassigned per `User-agent:` line, so consecutive agent lines in one group do not union. `User-agent: *` followed by `User-agent: Googlebot` followed by `Disallow: /` leaves `applies` false and the group is ignored. | CAP-1 |
| 4 | `src/crawl/fetcher.ts:14-25` | `setTimeout(release, delayMs)` is scheduled when the turn is granted, not when the response completes, so the gate releases while the request is still in flight. The "one in-flight request per host" the doc comment claims does not hold whenever a response takes longer than the delay. | CAP-2 |
| 5 | `src/crawl/discover.ts:214-219` | The `.gz` check runs after `fetchText` has already downloaded the file, and after `files++` has spent a slot of `SITEMAP_FILE_BUDGET`. | CAP-12 |

## Missing capabilities

Deferred: rendered-page fetching for JavaScript-built recipe pages. `src/crawl/fetcher.ts` uses `fetch()` only, so a recipe assembled client-side is never in the HTML any tier sees. Out of scope for this spec (see Non-goals in SPEC.md); CAP-7 is retired and not reused.

| # | Location | Gap | CAP |
|---|---|---|---|
| 6 | `src/crawl/run.ts:41-60`, schema `crawl_queue.url_hash` unique | `enqueue` is `on conflict (url_hash) do nothing` against a globally unique column, so a URL that reached `done` can never be re-queued. Combined with `parse/run.ts:28` filtering on `not exists (staging where url_hash)`, a source that edits a recipe is invisible until someone runs `parse --force`. `crawler.sources` also carries no recrawl interval to schedule against. | CAP-3 |
| 7 | `src/crawl/fetcher.ts:56-72`, `raw_pages` schema | No ETag or Last-Modified is stored or sent, so any revisit is a full re-download. | CAP-4 |
| 8 | `src/crawl/fetcher.ts:96-116` | `fetchWithRetry` retries 429 on a fixed `1000 * 2 ** attempt` backoff and never reads `Retry-After`. | CAP-4 |
| 9 | `src/crawl/run.ts:69`, `crawl_queue.locked_at` | `locked_at` is written at claim time and read by nothing. A process killed mid-batch strands its claimed rows in `fetching` permanently — they are neither retried nor visible as failures. | CAP-5 |
| 10 | `src/crawl/extract.ts:19-31`, `src/crawl/adapters/index.ts:16` | Tiers A and B require machine-readable markup and tier C's registry is empty, so a prose recipe page yields `{recipe: null, extractor: 'none'}`. `crawl/run.ts:117` still stores the HTML with `extracted = null`, and `parse/run.ts:28` then skips it forever. | CAP-6 |
| 12 | `src/crawl/discover.ts` link walk | `seen` is a per-run in-memory `Set`, so a second discovery run refetches pages already in `raw_pages`. | CAP-8 |
| 13 | `src/crawl/discover.ts` link walk and `--verify` path | `ingestFetchedPage` is called only inside `if (recipe)`, so HTML for a page that no tier recognised is discarded. This is what makes the plain-prose case cost a second crawl rather than an offline re-extraction. | CAP-8, CAP-6 |
| 14 | `raw_pages.html` column | Full uncompressed HTML in a Postgres column, retained indefinitely, no policy. This is the table that will dominate database size; the HTML belongs in object storage with only a reference and the content hash in the row. | CAP-9 |
| 15 | `src/crawl/run.ts:249-273` | `extractionReport()` aggregates the current state of `raw_pages` by domain. There is no per-run record, so "did last night's crawl get worse" is unanswerable. | CAP-10 |
| 16 | `backend/test/` | Covers `discover`, `parse`, `enrich`, `api`, `auth`, `seed`. Nothing exercises `robots.ts` or `fetcher.ts` — the two modules carrying defects 1–4. | CAP-11 |

## Notes that shaped the capabilities

- `raw_pages` being append-only and keyed `unique (url_hash, content_hash)` is why CAP-3 and CAP-6 are cheap: freshness is a new row, and re-extraction is a read of a page already fetched. The key stays; CAP-9 changes only where the HTML behind it lives.
- The `ENRICHMENT_VERSION` pattern in `enrich/run.ts:24-33` is the precedent CAP-6 should follow — a version column on the extraction result, and a selection query that picks up anything stamped below the current version.
- `hostGate` in `fetcher.ts:11` grows one entry per host for the process lifetime. Not a problem at current scale; worth noting if CAP-3 turns crawls into long-running jobs.
