-- The canonical ingredient dictionary. This is what makes shopping-list merging
-- ("2 cloves garlic" + "1 tsp minced garlic") and voice queries possible.

create table if not exists crawler.ingredients_canonical (
  id                bigserial primary key,
  slug              text    not null unique,
  display_name      text    not null,
  aliases           text[]  not null default '{}',
  category          text,   -- produce | dairy | meat | seafood | pantry | spice | bakery | other
  default_unit      text,
  -- { "cup": 120, "tbsp": 8, "piece": 50 } -> grams per 1 of that unit
  grams_per_unit    jsonb   not null default '{}'::jsonb,
  density_g_per_ml  numeric,
  is_pantry_staple  boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists ingredients_canonical_aliases_idx
  on crawler.ingredients_canonical using gin (aliases);

create index if not exists ingredients_canonical_name_trgm_idx
  on crawler.ingredients_canonical using gin (display_name gin_trgm_ops);

-- Strings the matcher could not resolve. Drain this table to grow the dictionary;
-- it is the single highest-leverage manual task in the whole pipeline.
create table if not exists crawler.unmatched_ingredients (
  id          bigserial primary key,
  raw_name    text    not null,
  normalized  text    not null unique,
  occurrences integer not null default 1,
  example_url text,
  resolved_to bigint  references crawler.ingredients_canonical(id) on delete set null,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
