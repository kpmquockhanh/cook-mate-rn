-- Tier D: extraction by a model, for pages the free tiers could not read.
--
-- Version-stamped like enrichment, and for the same reason: improving the
-- prompt has to re-run over pages already stored, never over the network. A
-- row stamped below the current EXTRACTION_VERSION is picked up again; a row
-- stamped at it is left alone, including one where the model concluded the
-- page holds no recipe. Recording that verdict is what stops the pipeline
-- paying to re-read the same category listing every run.

alter table crawler.raw_pages
  add column if not exists extraction_version integer,
  add column if not exists extraction_model   text;

-- The selection query is "pages nothing could read, not yet looked at by the
-- current prompt version".
create index if not exists raw_pages_extraction_pending_idx
  on crawler.raw_pages (extractor, extraction_version);
