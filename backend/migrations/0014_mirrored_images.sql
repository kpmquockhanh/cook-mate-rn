-- Where a recipe's photos live once we hold them ourselves.
--
-- Until now the pipeline carried only the source's own URLs (`image_url`,
-- `image_urls`), and the publisher either passed them through to the app or
-- dropped them, depending on the source's `allow_image_use`. Passing them
-- through means hotlinking someone else's CDN: their bandwidth, their rate
-- limits, their hotlink protection, and a blank card the day they reorganise.
--
-- `image_paths` holds object paths inside our own public storage bucket
-- (src/storage/images.ts), in the same order as `image_urls` - first is the
-- hero. Empty means the stage has not run for this row, or the source does not
-- permit mirroring; the publisher falls back to the old behaviour in that case,
-- so this migration changes nothing on its own.

alter table if exists crawler.recipe_staging
  add column if not exists image_paths text[] not null default '{}';

-- When the mirror last ran for this row, so the stage can select what it has
-- not seen and skip what it has.
alter table if exists crawler.recipe_staging
  add column if not exists images_mirrored_at timestamptz;

create index if not exists recipe_staging_images_idx
  on crawler.recipe_staging (images_mirrored_at)
  where images_mirrored_at is null;
