-- Facets: the columns the home screen and the recipe list actually navigate by.
--
-- Until now the app derived these on the client from `title` and the scraped
-- `category` (lib/recipeFacets.ts), because nothing else was available. That
-- column is source free text - 25 distinct values across 45 recipes, including
-- 'Lemon' and 'Copycat' - so it could never carry navigation. These columns are
-- computed once at publish time from what the pipeline already knows: the
-- enrichment model's own reading of the recipe, and the canonical ingredient
-- links.
--
-- Everything here is nullable. A recipe published before this migration, or one
-- whose ingredients did not all resolve to the dictionary, has no facets rather
-- than wrong ones - and the API's filters simply do not return it.

-- ---------------------------------------------------------------------------
-- public.recipes
-- ---------------------------------------------------------------------------

-- The numeric time behind `cooking_time`. That column is a human string
-- ('1h 20m') the app renders verbatim, so it cannot be compared or ordered.
alter table if exists public.recipes add column if not exists total_time_seconds  integer;

-- Total minus the unattended stretches the enricher already identifies per
-- step. This is the number that distinguishes an 8-hour slow cooker (15 minutes
-- of work) from a 2-hour pastry (two hours of work), and no recipe site
-- publishes it.
alter table if exists public.recipes add column if not exists active_time_seconds integer;

-- breakfast | lunch | dinner | dessert | snack | basics
alter table if exists public.recipes add column if not exists meal               text;

-- chicken | beef | pork | seafood | pasta | egg | veg
alter table if exists public.recipes add column if not exists main_ingredient    text;

-- Any of: vegetarian | vegan | pescatarian | gluten_free. Empty means unknown,
-- never "none of them": a claim about what someone can eat is only made when
-- every ingredient in the recipe resolved to the canonical dictionary.
alter table if exists public.recipes add column if not exists diet               text[] not null default '{}';

create index if not exists recipes_meal_idx        on public.recipes (meal);
create index if not exists recipes_main_ing_idx    on public.recipes (main_ingredient);
create index if not exists recipes_total_time_idx  on public.recipes (total_time_seconds);
create index if not exists recipes_active_time_idx on public.recipes (active_time_seconds);
create index if not exists recipes_diet_idx        on public.recipes using gin (diet);

-- ---------------------------------------------------------------------------
-- crawler.ingredients_canonical
--
-- What an ingredient means for a diet, kept on the dictionary rather than
-- recomputed from names at publish time. One array instead of a boolean per
-- property, so a new distinction (nuts, shellfish, alcohol) needs seed data,
-- not another migration.
--
-- Vocabulary, and what each one rules out:
--   meat    - vegetarian, pescatarian, vegan  (includes chicken and beef stock)
--   seafood - vegetarian, vegan               (includes fish and oyster sauce)
--   dairy   - vegan
--   egg     - vegan                           (includes mayonnaise)
--   animal  - vegan only, for what vegetarians still eat: honey
--   gluten  - gluten_free
-- ---------------------------------------------------------------------------
alter table if exists crawler.ingredients_canonical
  add column if not exists dietary_tags text[] not null default '{}';

create index if not exists ingredients_canonical_dietary_idx
  on crawler.ingredients_canonical using gin (dietary_tags);
