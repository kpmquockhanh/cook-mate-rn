-- Per-user rows key on Clerk user ids now.
--
-- Auth moved from Supabase (auth.users.id, a uuid) to Clerk, whose ids are
-- opaque strings like `user_2abc...`. There were no real users to carry over,
-- so the rows are dropped rather than remapped: a favourite keyed on a Supabase
-- uuid would never match a Clerk id again anyway.
--
-- The "own rows" policies compared user_id to auth.uid(). They go: auth.uid()
-- is a Supabase Auth concept that no longer means anything here. RLS stays
-- enabled with no policy, which denies everything through PostgREST and changes
-- nothing for the API, which connects as the table owner.

truncate public.user_favorites, public.user_recipe_events;

drop policy if exists "own rows" on public.user_favorites;
drop policy if exists "own rows" on public.user_recipe_events;

-- `type text` rebuilds the primary key and the user_id indexes in place.
alter table public.user_favorites alter column user_id type text;
alter table public.user_recipe_events alter column user_id type text;

alter table public.user_favorites drop constraint if exists user_favorites_user_id_nonempty;
alter table public.user_favorites
  add constraint user_favorites_user_id_nonempty check (user_id <> '');

alter table public.user_recipe_events drop constraint if exists user_recipe_events_user_id_nonempty;
alter table public.user_recipe_events
  add constraint user_recipe_events_user_id_nonempty check (user_id <> '');
