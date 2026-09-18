-- Drop the HTML column, once every page is in object storage.
--
-- Guarded on purpose. `migrate` runs every pending file in one invocation, so
-- without this check a fresh `npm run migrate` on an existing deployment would
-- add the storage column and drop the HTML in the same breath, destroying every
-- page that had not been moved yet. Failing loudly here costs one extra command
-- and cannot lose data; each migration runs in its own transaction, so 0006
-- stays applied and this one simply retries.

do $$
declare
  pending bigint;
begin
  select count(*) into pending
    from crawler.raw_pages
   where html is not null and storage_path is null;

  if pending > 0 then
    raise exception
      'raw_pages still has % page(s) whose HTML has not been moved to object storage. '
      'Run `npm run dev -- storage backfill` first, then re-run `npm run migrate`.', pending;
  end if;
end $$;

alter table crawler.raw_pages drop column if exists html;
