-- Additive-only provenance columns on the app's own `recipes` table.
--
-- Every statement is guarded, so this migration is a no-op if your published
-- schema uses different table names. Run `npm run publish -- --check` afterwards:
-- it introspects information_schema and tells you exactly which target columns
-- the publisher needs and which are missing.

alter table if exists public.recipes add column if not exists source_url          text;
alter table if exists public.recipes add column if not exists source_name         text;
alter table if exists public.recipes add column if not exists source_license      text;
alter table if exists public.recipes add column if not exists url_hash            text;
alter table if exists public.recipes add column if not exists content_fingerprint text;
alter table if exists public.recipes add column if not exists quality_score       integer;
alter table if exists public.recipes add column if not exists enrichment_version  integer;
alter table if exists public.recipes add column if not exists edited_by_human     boolean default false;
alter table if exists public.recipes add column if not exists crawled_at          timestamptz;
alter table if exists public.recipes add column if not exists published_at        timestamptz;

-- url_hash is the idempotency key for republishing: re-running the pipeline on a
-- source you already ingested updates that row instead of creating a duplicate.
do $$
begin
  if to_regclass('public.recipes') is not null then
    create unique index if not exists recipes_url_hash_key
      on public.recipes (url_hash) where url_hash is not null;
  end if;
end $$;

-- Link published ingredient rows back to the canonical dictionary so the
-- shopping list can merge across recipes.
alter table if exists public.recipe_ingredients
  add column if not exists canonical_id bigint;
alter table if exists public.recipe_ingredients
  add column if not exists qty numeric;
alter table if exists public.recipe_ingredients
  add column if not exists unit text;
alter table if exists public.recipe_ingredients
  add column if not exists qty_grams numeric;

do $$
begin
  if to_regclass('public.recipe_ingredients') is not null
     and to_regclass('crawler.ingredients_canonical') is not null
     and not exists (
       select 1 from pg_constraint where conname = 'recipe_ingredients_canonical_fk'
     )
  then
    alter table public.recipe_ingredients
      add constraint recipe_ingredients_canonical_fk
      foreign key (canonical_id)
      references crawler.ingredients_canonical(id)
      on delete set null;
  end if;
end $$;
