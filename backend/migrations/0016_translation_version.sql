-- The lever that re-runs translation over the whole corpus after a prompt change.
--
-- `source_fingerprint` (migration 0015) answers "has the RECIPE changed since
-- this was translated". It cannot answer "has our PROMPT changed", and that is
-- the other reason a translation goes out of date - the first pass will get
-- Vietnamese culinary register wrong in ways only reading it reveals, and the
-- fix is a better prompt applied to everything already translated.
--
-- Same lever the pipeline already has twice: ENRICHMENT_VERSION for stage 2 and
-- EXTRACTION_VERSION for tier D. Bumping TRANSLATION_VERSION makes `translate`
-- select every row stamped with a lower number. Nothing is invalidated on its
-- own - the old translation keeps serving until a new one replaces it, so a
-- bump costs model calls, never a blank screen.

alter table if exists public.recipe_translations
  add column if not exists translation_version integer;

-- What still needs re-translating at the current version, per locale. The
-- primary key leads with recipe_id, so it cannot answer this one.
create index if not exists recipe_translations_version_idx
  on public.recipe_translations (locale, translation_version);
