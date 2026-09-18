-- Freshness: revisit sources on a schedule, cheaply, and recover stranded work.
--
-- Three gaps, one lifecycle. A URL that reached `done` could never be re-queued
-- (`url_hash` is globally unique and `enqueue` is `on conflict do nothing`), so
-- a recipe edited at its source stayed invisible. Nothing recorded HTTP
-- validators, so any revisit would have been a full re-download. And
-- `locked_at` was written at claim time and read by nothing, so a crashed run
-- stranded its rows in `fetching` for good.

-- Per-source, alongside crawl_delay_ms and allow_image_use: how often this
-- site is worth revisiting. NULL disables revisiting for that source.
alter table crawler.sources
  add column if not exists recrawl_interval_hours integer default 720;

comment on column crawler.sources.recrawl_interval_hours is
  'Hours before a fetched URL from this source is due again. NULL disables revisits. Default 720 (30 days).';

-- HTTP validators, so a revisit that finds nothing changed costs one 304 and
-- no body. They belong to the fetch, which is what crawl_queue records.
alter table crawler.crawl_queue
  add column if not exists etag          text,
  add column if not exists last_modified text;

-- The scan is "finished long enough ago to be due again".
create index if not exists crawl_queue_refresh_idx
  on crawler.crawl_queue (status, finished_at)
  where status = 'done';

-- The stale-lock sweep reads this.
create index if not exists crawl_queue_locked_idx
  on crawler.crawl_queue (locked_at)
  where status = 'fetching';
