-- What people actually do with a recipe.
--
-- Until now the app had no per-user state at all: the heart on a recipe card
-- was decoration, and the home screen's "Popular" rail ordered by the scraped
-- source rating - a number from someone else's website, 5.00 on most rows.
-- These two tables are where a real signal comes from.
--
-- Both key on `auth.users.id` without a foreign key to it: Supabase owns that
-- table, and an FK into another schema's managed table is a migration hazard
-- for no benefit here. A deleted user leaves rows that match no one and are
-- never read; a deleted recipe cascades, because a favourite of nothing is
-- not a favourite.

-- ---------------------------------------------------------------------------
-- Favourites. One row per (user, recipe): the primary key is the toggle.
-- ---------------------------------------------------------------------------
create table if not exists public.user_favorites (
  user_id    uuid        not null,
  recipe_id  bigint      not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id)
);

-- The favourites list, newest first - the order the app shows them in.
create index if not exists user_favorites_user_idx
  on public.user_favorites (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Cooking events. Append-only, one row per thing that happened.
--
-- Kept as events rather than counters so the question can change later
-- ("popular this week" vs "popular ever", "what did I cook in March") without
-- another migration. 'started' is opening Cooking Mode; 'completed' is
-- reaching the last step, which is the only event that means someone actually
-- cooked the thing.
-- ---------------------------------------------------------------------------
create table if not exists public.user_recipe_events (
  id         bigserial   primary key,
  user_id    uuid        not null,
  recipe_id  bigint      not null references public.recipes(id) on delete cascade,
  kind       text        not null check (kind in ('viewed', 'started', 'completed')),
  created_at timestamptz not null default now()
);

-- Serves the popularity ranking: count by recipe, for one kind, over a window.
create index if not exists user_recipe_events_recipe_idx
  on public.user_recipe_events (recipe_id, kind, created_at desc);

-- Serves one user's own history.
create index if not exists user_recipe_events_user_idx
  on public.user_recipe_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS. The API reaches these as the table owner over a direct connection, so
-- it is unaffected; these policies are what stands between one user's rows and
-- anyone else holding the publishable key, since PostgREST exposes every table
-- in `public`.
--
-- `auth.uid()` only exists on Supabase. A plain local Postgres gets RLS with no
-- policy, which denies everything through PostgREST and changes nothing for the
-- owner connection.
-- ---------------------------------------------------------------------------
do $$
declare
  t        text;
  has_auth boolean;
begin
  select exists (select 1 from pg_namespace where nspname = 'auth') into has_auth;

  foreach t in array array['user_favorites', 'user_recipe_events'] loop
    execute format('alter table public.%I enable row level security', t);

    if has_auth and not exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = t and policyname = 'own rows'
    ) then
      execute format(
        'create policy "own rows" on public.%I for all to authenticated
           using (user_id = auth.uid()) with check (user_id = auth.uid())',
        t
      );
    end if;
  end loop;
end $$;
