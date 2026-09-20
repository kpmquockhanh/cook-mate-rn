-- Recipe content in a language other than the one it was scraped in.
--
-- The app's UI strings have been translated since lib/i18n, but the recipes
-- themselves are whatever the source wrote - English, on every source we crawl.
-- A Vietnamese user gets a Vietnamese interface wrapped around an English
-- recipe, which is the half of the job that matters least.
--
-- These are OVERLAY tables, never a second copy of a recipe:
--
--   * Only free text lives here. Every number - qty, qty_grams, duration,
--     servings, the facet columns - stays on the base row and is shared by
--     all locales. Servings scaling, the shopping list, the timers and the
--     facet filters therefore keep working untouched, and there is exactly one
--     place a quantity can be wrong.
--   * A missing translation is not an error. The API coalesces to the base
--     row, so a half-translated corpus renders as a mix rather than a blank
--     screen, and this migration changes nothing until something writes here.
--
-- WHY CHILDREN ARE KEYED BY sort_order, NOT BY CHILD id
--
-- publish/run.ts:211 deletes and re-inserts every child row of a recipe on
-- each publish - "replace-on-publish", so instruction order and ingredient
-- indices stay internally consistent. Child ids are therefore NOT stable: a
-- translation keyed to recipe_ingredients.id would be cascade-deleted by a
-- republish that changed nothing at all. (This is the reason the equivalent
-- feature was rejected upstream in Mealie: keeping translations in sync with
-- the original was judged not reliably doable.) `sort_order` is the position
-- the publisher writes deterministically from the staging row, so it survives
-- a republish of identical content.
--
-- HOW STALENESS IS CAUGHT
--
-- Position alone would be wrong the moment the content behind it changes:
-- step 3 of a recrawled recipe may be a different step. So every translation
-- row records the `content_fingerprint` of the recipe it was made from, and
-- the API only applies an overlay whose fingerprint still matches the base
-- row's. A recrawl that genuinely changed the recipe moves the fingerprint,
-- every overlay for it stops being applied that instant, and the reader sees
-- the (correct) source language until the translation stage catches up.
-- Stale text is worse than untranslated text: the cook follows it.

-- ---------------------------------------------------------------------------
-- Recipe-level text.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_translations (
  recipe_id   bigint not null references public.recipes(id) on delete cascade,
  -- BCP 47, matching lib/i18n/languages.ts: 'vi', 'en'. Not an enum and not a
  -- check against a fixed list, so a new language is seed data rather than a
  -- migration.
  locale      text   not null check (locale ~ '^[a-z]{2}(-[A-Za-z]{2,4})?$'),

  title       text   not null,
  description text,
  -- Display only. The `cuisine` the API *filters* by stays the base column, so
  -- a localized label can never split a facet in two.
  cuisine     text,

  -- public.recipes.content_fingerprint as it was when this was written. Null
  -- on both sides is a match (`is not distinct from`), which is what rows
  -- published before migration 0003 need.
  source_fingerprint text,
  -- Ops, not logic: which model produced this, and when.
  model              text,
  translated_at      timestamptz not null default now(),

  primary key (recipe_id, locale)
);

-- Deliberately absent: cooking_time. It is a pre-formatted human string
-- ('1h 20m') the app renders verbatim, and translating a formatted string is
-- how you end up with '1 giờ 20m'. total_time_seconds is already published, so
-- the client formats it from its own duration.* catalogue instead.

-- ---------------------------------------------------------------------------
-- Children. `sort_order` matches the base child row's; see the header.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_ingredient_translations (
  recipe_id       bigint  not null references public.recipes(id) on delete cascade,
  locale          text    not null,
  sort_order      integer not null,
  -- The rendered line. The canonical link (canonical_id, qty, unit, qty_grams)
  -- is NOT duplicated here - the shopping list and scaling read it from the
  -- base row whatever language is on screen.
  ingredient_text text    not null,
  amount          text,
  primary key (recipe_id, locale, sort_order)
);

create table if not exists public.recipe_instruction_translations (
  recipe_id        bigint  not null references public.recipes(id) on delete cascade,
  locale           text    not null,
  sort_order       integer not null,
  instruction_text text    not null,
  timer_name       text,
  -- The step's ingredient list, which the cooking screen substring-matches
  -- against recipe_ingredients.ingredient_text to highlight what a step uses.
  -- It MUST be translated in lockstep with ingredient_text above, or the
  -- highlighting silently stops matching on a translated recipe. Hence a
  -- column here rather than reuse of the base jsonb.
  ingredients      jsonb   not null default '[]'::jsonb,
  duration_hint    integer,  -- unused by the API; kept for translator QA only
  primary key (recipe_id, locale, sort_order)
);

create table if not exists public.recipe_note_translations (
  recipe_id  bigint  not null references public.recipes(id) on delete cascade,
  locale     text    not null,
  sort_order integer not null,
  note_text  text    not null,
  primary key (recipe_id, locale, sort_order)
);

-- recipe_images needs no translation: an image_path is the same in every
-- language, which is the whole point of keeping images out of the overlay.

-- Every lookup is by (recipe_id, locale) and every primary key leads with
-- those two, so the PK indexes serve the joins. One extra index earns its
-- keep: finding what still needs translating, per locale.
create index if not exists recipe_translations_locale_idx
  on public.recipe_translations (locale, translated_at);

-- ---------------------------------------------------------------------------
-- RLS, on the same terms as migration 0000: Supabase serves every public table
-- through PostgREST, recipe text is public content, and only the publisher and
-- the translation stage write - both connect as the table owner and bypass RLS.
-- ---------------------------------------------------------------------------
do $$
declare
  t     text;
  roles text;
begin
  select string_agg(quote_ident(rolname), ', ')
    into roles
    from pg_roles
   where rolname in ('anon', 'authenticated');

  foreach t in array array[
    'recipe_translations',
    'recipe_ingredient_translations',
    'recipe_instruction_translations',
    'recipe_note_translations'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    if roles is not null and not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = t and policyname = 'public read'
    ) then
      execute format(
        'create policy "public read" on public.%I for select to %s using (true)',
        t, roles
      );
    end if;
  end loop;
end $$;
