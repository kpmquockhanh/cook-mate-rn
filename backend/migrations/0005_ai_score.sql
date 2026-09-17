-- Additive-only: the model's own 0-10 quality judgment from stage 2
-- enrichment, distinct from `rating` (the scraped source's star rating).

alter table if exists public.recipes add column if not exists ai_score numeric(3,1);
