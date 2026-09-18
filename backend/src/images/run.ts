import { fetchBytes } from '../crawl/fetcher.js';
import { normalizeImages } from '../crawl/images.js';
import { query } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { ensureImageBucket, isSupportedImageType, storeImage } from '../storage/images.js';

const log = logger('images');

/**
 * Mirror stage. Downloads each recipe's photos and stores them in our own
 * public bucket, so the app serves images we hold rather than hotlinking the
 * source's CDN.
 *
 * It runs after parse (which fills `image_urls`) and before publish (which
 * copies the stored paths onto the app's tables). Safe to re-run: object keys
 * are content hashes, so a repeat writes the same bytes to the same key.
 *
 * Licensing is checked here, once: `sources.allow_image_use` decides whether a
 * source's photos may be copied at all, and a source with it off is skipped
 * before anything is downloaded. That flag is a deliberate per-source decision,
 * not a default to work around.
 */
interface MirrorRow {
  id: number;
  source_url: string;
  image_url: string | null;
  image_urls: string[];
  source_delay_ms: number | null;
}

/**
 * How many recipes are waiting for their photos, for the console's backlog
 * number. Counts only what the stage would actually work on: rows with photos,
 * from a source that permits copying them, not yet mirrored.
 */
export async function countPendingImages(): Promise<number> {
  const rows = await query<{ count: number }>(
    `select count(*)::int as count
       from crawler.recipe_staging st
       join crawler.sources s on s.id = st.source_id
      where s.allow_image_use = true
        and (jsonb_array_length(st.image_urls) > 0 or st.image_url is not null)
        and st.images_mirrored_at is null`,
  );
  return rows[0]?.count ?? 0;
}

export async function mirrorImages(
  limit: number,
  options: { force?: boolean } = {},
): Promise<{ rows: number; stored: number; failed: number }> {
  log.info(await ensureImageBucket());

  const rows = await query<MirrorRow>(
    `select st.id, st.source_url, st.image_url, st.image_urls,
            s.crawl_delay_ms as source_delay_ms
       from crawler.recipe_staging st
       join crawler.sources s on s.id = st.source_id
      where s.allow_image_use = true
        and (jsonb_array_length(st.image_urls) > 0 or st.image_url is not null)
        and ($2 or st.images_mirrored_at is null)
      order by st.id
      limit $1`,
    [limit, options.force ?? false],
  );

  if (rows.length === 0) {
    log.info('nothing to mirror (no rows, or their sources do not allow image use)');
    return { rows: 0, stored: 0, failed: 0 };
  }

  let stored = 0;
  let failed = 0;

  for (const row of rows) {
    // The hero first, then the gallery, deduped across both: parse records the
    // same photo at several CDN sizes, and `image_url` is usually image_urls[0].
    const candidates = normalizeImages(
      [row.image_url, ...row.image_urls].filter((url): url is string => Boolean(url)),
    ).slice(0, env.imagesPerRecipe);

    const paths: string[] = [];
    for (const url of candidates) {
      try {
        const path = await mirrorOne(url, row.source_delay_ms ?? undefined);
        if (path) paths.push(path);
      } catch (error) {
        failed++;
        log.warn(`#${row.id} ${url}: ${String(error).slice(0, 120)}`);
      }
    }

    // Stamped even when nothing was stored, so a row whose photos are all gone
    // is not retried on every run. `--force` is how you retry deliberately.
    await query(
      `update crawler.recipe_staging
          set image_paths = $2, images_mirrored_at = now()
        where id = $1`,
      [row.id, paths],
    );

    stored += paths.length;
    log.info(`#${row.id} mirrored ${paths.length}/${candidates.length}`);
  }

  log.info(`mirrored ${stored} image(s) across ${rows.length} recipe(s), ${failed} failed`);
  return { rows: rows.length, stored, failed };
}

/**
 * One photo, fetched through the crawler's own per-host gate, so mirroring is
 * as polite as crawling was and carries the same user agent.
 */
async function mirrorOne(url: string, sourceDelayMs?: number): Promise<string | null> {
  const { status, bytes, contentType } = await fetchBytes(
    url,
    sourceDelayMs,
    'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8',
  );

  if (status !== 200 || !bytes) {
    log.debug(`skip ${url}: HTTP ${status}`);
    return null;
  }
  if (!isSupportedImageType(contentType)) {
    // Usually an HTML error page served with a 200. Storing it would put a
    // broken image in the app and a lie in the database.
    log.debug(`skip ${url}: content-type ${contentType}`);
    return null;
  }
  if (bytes.byteLength > env.imageMaxBytes) {
    log.debug(`skip ${url}: ${bytes.byteLength} bytes exceeds IMAGE_MAX_BYTES`);
    return null;
  }

  return storeImage(bytes, contentType);
}
