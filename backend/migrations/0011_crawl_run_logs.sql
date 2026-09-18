-- The log a run produced, kept with the run instead of only on someone's
-- screen.
--
-- Until now a run's lines lived in the console's memory and were streamed to
-- whoever happened to be watching: closing the tab, restarting the server, or
-- simply starting a crawl overnight meant the log was gone by the time anyone
-- had a reason to read it. Counters say a run got worse; only the lines say
-- which URLs did it.

create table if not exists crawler.crawl_run_logs (
  id      bigserial   primary key,
  run_id  bigint      not null references crawler.crawl_runs (id) on delete cascade,
  -- Per-run line number, assigned in order by the process writing the run.
  -- Readers page with it ("everything after line 120"), which `id` could not
  -- do reliably once two runs interleave their inserts.
  seq     integer     not null,
  ts      timestamptz not null,
  level   text        not null,
  scope   text        not null,
  message text        not null,
  -- The serialized `extra` of the log call, already a string by the time it
  -- reaches a sink.
  extra   text
);

-- Every read is "this run's lines, in order, after seq N". Unique so a retried
-- insert batch cannot double up a line.
create unique index if not exists crawl_run_logs_run_seq_idx
  on crawler.crawl_run_logs (run_id, seq);
