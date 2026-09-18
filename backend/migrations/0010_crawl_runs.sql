-- Per-run counters, so "did last night's crawl get worse" is answerable.
--
-- The console's job runner keeps a live log, but only in memory and only until
-- the process restarts, and `crawl --report` aggregates the current state of
-- raw_pages rather than anything about a run. Neither can compare one run to
-- the one before it, which is the only question that matters once the pipeline
-- is being maintained rather than built.

create table if not exists crawler.crawl_runs (
  id          bigserial   primary key,
  kind        text        not null,
  status      text        not null default 'running'
              check (status in ('running','done','failed','cancelled')),
  -- What the run was asked to do, so two runs are compared like for like: a
  -- limit of 10 and a limit of 500 are not the same run twice.
  params      jsonb       not null default '{}'::jsonb,
  -- Flat counter names, one jsonb object. Different stages count different
  -- things, and adding a counter should not need a migration.
  counters    jsonb       not null default '{}'::jsonb,
  error       text,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

-- The console and `dev -- runs` both read "the last N runs of this kind".
create index if not exists crawl_runs_kind_started_idx
  on crawler.crawl_runs (kind, started_at desc);
