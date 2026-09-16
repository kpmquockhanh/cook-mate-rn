-- The app's own published schema: the five `public.*` tables the REST API
-- serves to the RN client and the publisher (stage 5) writes into.
--
-- This migration exists so a brand-new Supabase project can be brought up from
-- nothing. Installs that predate it already created these tables by hand; every
-- statement is `if not exists`, so applying it there changes nothing.
--
-- Column names are the other half of the contract in src/publish/mapping.ts.
-- Change one and you must change the other; `npm run publish -- --check` will
-- tell you when they disagree.
--
-- Provenance columns (source_url, url_hash, quality_score, ...) and the
-- canonical-ingredient columns are deliberately NOT here - migration 0003 adds
-- them, along with the unique index on url_hash that makes republishing
-- idempotent. Keeping them in one place means one definition, not two.

-- ---------------------------------------------------------------------------
-- Recipes. `id` is bigserial because the publisher reads it back as a number.
-- ---------------------------------------------------------------------------
create table if not exists public.recipes (
  id            bigserial primary key,
  title         text        not null,
  description   text,
  -- Single hero image. Additional images live in recipe_images.
  thumbnail     text,
  -- Human-readable, e.g. '1h 20m' - formatCookingTime() produces it and the
  -- app renders it verbatim, so it is text rather than an interval.
  cooking_time  text,
  servings      integer,
  difficulty    text        check (difficulty in ('easy','medium','hard')),
  rating        numeric(3,2),
  review_count  integer     not null default 0,
  category      text,
  cuisine       text,
  created_at    timestamptz not null default now()
);

create index if not exists recipes_category_idx on public.recipes (category);
create index if not exists recipes_cuisine_idx  on public.recipes (cuisine);

-- ---------------------------------------------------------------------------
-- Children. All four are replace-on-publish, so they cascade from the recipe
-- and carry an explicit sort_order rather than relying on insertion order.
-- ---------------------------------------------------------------------------
create table if not exists public.recipe_images (
  id         bigserial primary key,
  recipe_id  bigint  not null references public.recipes(id) on delete cascade,
  image_path text    not null,
  sort_order integer not null default 0
);

create table if not exists public.recipe_ingredients (
  id              bigserial primary key,
  recipe_id       bigint  not null references public.recipes(id) on delete cascade,
  -- The exact string the app renders AND the string the cooking screen
  -- substring-matches recipe_instructions.ingredients against. Keep verbatim.
  ingredient_text text    not null,
  amount          text,
  sort_order      integer not null default 0
);

create table if not exists public.recipe_instructions (
  id               bigserial primary key,
  recipe_id        bigint  not null references public.recipes(id) on delete cascade,
  instruction_text text    not null,
  -- jsonb array of ingredient_text strings used by this step.
  ingredients      jsonb   not null default '[]'::jsonb,
  duration         integer,          -- seconds; drives the in-app timer
  timer_name       text,
  sort_order       integer not null default 0
);

create table if not exists public.recipe_notes (
  id         bigserial primary key,
  recipe_id  bigint  not null references public.recipes(id) on delete cascade,
  note_text  text    not null,
  sort_order integer not null default 0
);

create index if not exists recipe_images_recipe_idx       on public.recipe_images (recipe_id, sort_order);
create index if not exists recipe_ingredients_recipe_idx  on public.recipe_ingredients (recipe_id, sort_order);
create index if not exists recipe_instructions_recipe_idx on public.recipe_instructions (recipe_id, sort_order);
create index if not exists recipe_notes_recipe_idx        on public.recipe_notes (recipe_id, sort_order);

-- ---------------------------------------------------------------------------
-- RLS. Supabase exposes every public table through PostgREST, so anyone
-- holding the publishable key can reach these. Recipes are public content:
-- read for everyone, writes only via the publisher, which connects directly as
-- the table owner and therefore bypasses RLS.
-- `create policy` has no IF NOT EXISTS, hence the guard.
-- ---------------------------------------------------------------------------
do $$
declare
  t     text;
  roles text;
begin
  -- `anon` and `authenticated` are Supabase's roles; a plain local Postgres has
  -- neither, so build the grantee list from what actually exists and skip the
  -- policy entirely when it is empty. RLS still gets enabled either way.
  select string_agg(quote_ident(rolname), ', ')
    into roles
    from pg_roles
   where rolname in ('anon', 'authenticated');

  foreach t in array array[
    'recipes','recipe_images','recipe_ingredients','recipe_instructions','recipe_notes'
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
