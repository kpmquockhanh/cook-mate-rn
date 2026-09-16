-- Stage 0/1 storage: sources, crawl queue, immutable raw pages, parsed staging.
-- Everything lives in its own `crawler` schema so it can never collide with the
-- app tables your REST API reads.

create schema if not exists crawler;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Sources: one row per domain, carrying crawl policy + licensing posture.
-- ---------------------------------------------------------------------------
create table if not exists crawler.sources (
  id                    bigserial primary key,
  domain                text        not null unique,
  name                  text        not null,
  license               text,
  attribution_required  boolean     not null default true,
  -- Photos are copyrightable even when the ingredient list is not. Only set
  -- this true for sources whose licence actually permits it.
  allow_image_use       boolean     not null default false,
  crawl_delay_ms        integer     not null default 2000,
  enabled               boolean     not null default true,
  notes                 text,
  created_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Crawl queue. One row per URL, claimed by workers with FOR UPDATE SKIP LOCKED.
-- ---------------------------------------------------------------------------
create table if not exists crawler.crawl_queue (
  id           bigserial primary key,
  url          text        not null,
  url_hash     text        not null unique,
  source_id    bigint      references crawler.sources(id) on delete set null,
  status       text        not null default 'pending'
               check (status in ('pending','fetching','done','failed','skipped')),
  attempts     integer     not null default 0,
  last_error   text,
  priority     integer     not null default 100,
  enqueued_at  timestamptz not null default now(),
  locked_at    timestamptz,
  finished_at  timestamptz
);

create index if not exists crawl_queue_claim_idx
  on crawler.crawl_queue (status, priority, id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Raw pages: immutable. Never edited, only inserted. Re-running the parser or
-- the enricher reads from here instead of re-hitting the network.
-- ---------------------------------------------------------------------------
create table if not exists crawler.raw_pages (
  id            bigserial primary key,
  url           text        not null,
  url_hash      text        not null,
  source_id     bigint      references crawler.sources(id) on delete set null,
  http_status   integer,
  content_hash  text        not null,
  html          text,
  -- schema.org-shaped output of whichever extractor tier won
  extracted     jsonb,
  extractor     text        not null,
  fetched_at    timestamptz not null default now(),
  unique (url_hash, content_hash)
);

create index if not exists raw_pages_url_hash_idx on crawler.raw_pages (url_hash);

-- ---------------------------------------------------------------------------
-- Staging: one row per recipe, carried through parse -> enrich -> gate -> publish.
-- ---------------------------------------------------------------------------
create table if not exists crawler.recipe_staging (
  id                  bigserial primary key,
  raw_page_id         bigint      not null references crawler.raw_pages(id) on delete cascade,
  url_hash            text        not null unique,
  source_url          text        not null,
  source_id           bigint      references crawler.sources(id) on delete set null,

  -- stage 1 (deterministic parse)
  title               text,
  description         text,
  image_url           text,
  image_urls          jsonb       not null default '[]'::jsonb,
  servings            integer,
  total_time_seconds  integer,
  prep_time_seconds   integer,
  cook_time_seconds   integer,
  cuisine             text,
  category            text,
  keywords            text[]      not null default '{}',
  source_rating       numeric(3,2),
  source_review_count integer,
  ingredients         jsonb       not null default '[]'::jsonb,  -- ParsedIngredient[]
  steps               jsonb       not null default '[]'::jsonb,  -- { index, text }[]

  -- stage 2 (LLM enrichment)
  enriched            jsonb,
  enrichment_version  integer,
  enrichment_model    text,

  -- stage 3 (gate)
  content_fingerprint text,
  quality_score       integer,
  quality_issues      jsonb       not null default '[]'::jsonb,

  status              text        not null default 'parsed'
                      check (status in ('parsed','enriched','review','approved','published','rejected')),
  edited_by_human     boolean     not null default false,
  published_recipe_id bigint,

  parsed_at           timestamptz,
  enriched_at         timestamptz,
  gated_at            timestamptz,
  published_at        timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists recipe_staging_status_idx on crawler.recipe_staging (status);
create index if not exists recipe_staging_fingerprint_idx on crawler.recipe_staging (content_fingerprint);

-- Schema-version bookkeeping for the `migrate` command.
create table if not exists crawler.schema_migrations (
  filename   text primary key,
  applied_at timestamptz not null default now()
);
