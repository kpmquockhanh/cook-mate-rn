-- Normalise the republish idempotency key.
--
-- 0003 created recipes_url_hash_key as a PARTIAL index (`where url_hash is not
-- null`). Postgres will not infer a partial unique index as an ON CONFLICT
-- arbiter unless the statement repeats the predicate, so the publisher's
-- `on conflict (url_hash) do update` in src/publish/run.ts fails with 42P10
-- against it.
--
-- The predicate was never needed: NULLs are distinct in a standard unique
-- index, so a plain one already allows any number of rows with no url_hash.
-- Replace it rather than teaching every caller about the predicate.
--
-- 0003 is left untouched on purpose - it has already been applied on existing
-- installs, and rewriting an applied migration hides the change from them.

do $$
begin
  if to_regclass('public.recipes') is null then
    return;
  end if;

  -- Only drop it if it is actually the partial one; a hand-made unique
  -- constraint from before this repo existed should be left alone.
  if exists (
    select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'recipes_url_hash_key'
       and i.indpred is not null
  ) then
    drop index public.recipes_url_hash_key;
  end if;

  create unique index if not exists recipes_url_hash_key
    on public.recipes (url_hash);
end $$;
