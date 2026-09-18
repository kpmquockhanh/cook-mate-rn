-- Move crawled HTML out of Postgres and into object storage.
--
-- `raw_pages.html` is the largest thing the pipeline keeps and the least often
-- read: it exists so extraction can be re-run without re-crawling, which is a
-- batch operation, not a query path. Keeping it in a column makes the database
-- grow with the corpus for no benefit the corpus provides.
--
-- This migration only adds the reference. The bytes are moved by
-- `npm run dev -- storage backfill`, and the column is dropped by 0007, which
-- refuses to run until the move is complete.

alter table crawler.raw_pages
  add column if not exists storage_path text;

-- Content-addressed: the same HTML reached by two URLs is one object. The
-- index supports the backfill's "what is left" scan and any future sweep for
-- objects nothing references any more.
create index if not exists raw_pages_storage_path_idx
  on crawler.raw_pages (storage_path);
