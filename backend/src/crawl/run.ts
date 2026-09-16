import { query, transaction } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { canonicalizeUrl, domainOf, sha256, urlHash } from '../util.js';
import { extractRecipe } from './extract.js';
import { fetchWithRetry } from './fetcher.js';
import { isAllowed } from './robots.js';

const log = logger('crawl');

interface QueueRow {
  id: number;
  url: string;
  url_hash: string;
  source_id: number | null;
  attempts: number;
}

interface SourceRow {
  id: number;
  domain: string;
  name: string;
  crawl_delay_ms: number;
  enabled: boolean;
}

/** Upsert a source row for a domain so every URL has a policy to obey. */
async function ensureSource(url: string): Promise<SourceRow> {
  const domain = domainOf(url);
  const rows = await query<SourceRow>(
    `insert into crawler.sources (domain, name, crawl_delay_ms)
     values ($1, $1, $2)
     on conflict (domain) do update set domain = excluded.domain
     returning id, domain, name, crawl_delay_ms, enabled`,
    [domain, env.crawlDefaultDelayMs],
  );
  return rows[0]!;
}

export async function enqueue(urls: string[], priority = 100): Promise<number> {
  let added = 0;
  for (const raw of urls) {
    let canonical: string;
    try {
      canonical = canonicalizeUrl(raw);
    } catch {
      log.warn(`skipping unparseable url: ${raw}`);
      continue;
    }
    const source = await ensureSource(canonical);
    const rows = await query(
      `insert into crawler.crawl_queue (url, url_hash, source_id, priority)
       values ($1, $2, $3, $4)
       on conflict (url_hash) do nothing
       returning id`,
      [canonical, urlHash(canonical), source.id, priority],
    );
    if (rows.length > 0) added++;
  }
  log.info(`enqueued ${added} new url(s) (${urls.length - added} already queued)`);
  return added;
}

/** Claim a batch of pending URLs atomically so multiple workers can run. */
async function claim(limit: number): Promise<QueueRow[]> {
  return transaction(async (client) => {
    const result = await client.query<QueueRow>(
      `update crawler.crawl_queue q
          set status = 'fetching', locked_at = now(), attempts = q.attempts + 1
        where q.id in (
          select id from crawler.crawl_queue
           where status = 'pending'
           order by priority, id
           limit $1
           for update skip locked
        )
      returning q.id, q.url, q.url_hash, q.source_id, q.attempts`,
      [limit],
    );
    return result.rows;
  });
}

/** Put a transiently-failed URL back in the queue until it runs out of attempts. */
async function requeueOrFail(item: QueueRow, error: string) {
  const exhausted = item.attempts >= 3;
  await query(
    `update crawler.crawl_queue
        set status = $2, last_error = $3, finished_at = case when $2 = 'pending' then null else now() end
      where id = $1`,
    [item.id, exhausted ? 'failed' : 'pending', error],
  );
}

async function finish(id: number, status: 'done' | 'failed' | 'skipped', error?: string) {
  await query(
    `update crawler.crawl_queue
        set status = $2, last_error = $3, finished_at = now()
      where id = $1`,
    [id, status, error ?? null],
  );
}

async function crawlOne(item: QueueRow, delays: Map<number, number>): Promise<boolean> {
  if (!(await isAllowed(item.url))) {
    log.info(`robots.txt disallows ${item.url}`);
    await finish(item.id, 'skipped', 'robots.txt disallow');
    return false;
  }

  const result = await fetchWithRetry(item.url, delays.get(item.source_id ?? -1));
  if (!result.html) {
    await finish(item.id, 'failed', `HTTP ${result.status} or non-HTML body`);
    return false;
  }

  const { recipe, extractor } = extractRecipe(result.html, item.url);
  const contentHash = sha256(result.html);

  await query(
    `insert into crawler.raw_pages
       (url, url_hash, source_id, http_status, content_hash, html, extracted, extractor)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (url_hash, content_hash) do update
        set extracted = excluded.extracted, extractor = excluded.extractor, fetched_at = now()`,
    [
      item.url,
      item.url_hash,
      item.source_id,
      result.status,
      contentHash,
      result.html,
      recipe ? JSON.stringify(recipe) : null,
      extractor,
    ],
  );

  if (!recipe) {
    log.warn(`no recipe markup found: ${item.url}`);
    await finish(item.id, 'failed', 'no recipe markup (tiers A/B/C all missed)');
    return false;
  }

  log.info(`${extractor} -> ${recipe.name ?? '(untitled)'} (${recipe.recipeIngredient?.length ?? 0} ingredients)`);
  await finish(item.id, 'done');
  return true;
}

export async function crawl(limit: number): Promise<{ ok: number; failed: number }> {
  const sources = await query<SourceRow>(
    `select id, domain, name, crawl_delay_ms, enabled from crawler.sources`,
  );
  const delays = new Map(sources.map((s) => [s.id, s.crawl_delay_ms]));
  const disabled = new Set(sources.filter((s) => !s.enabled).map((s) => s.id));

  let ok = 0;
  let failed = 0;
  let remaining = limit;

  while (remaining > 0) {
    const batch = await claim(Math.min(env.crawlConcurrency * 2, remaining));
    if (batch.length === 0) break;
    remaining -= batch.length;

    // Different hosts run in parallel; fetcher.ts serializes within a host.
    await Promise.all(
      batch.map(async (item) => {
        if (item.source_id !== null && disabled.has(item.source_id)) {
          await finish(item.id, 'skipped', 'source disabled');
          return;
        }
        try {
          if (await crawlOne(item, delays)) ok++;
          else failed++;
        } catch (error) {
          failed++;
          log.error(`crawl failed: ${item.url}`, String(error));
          await requeueOrFail(item, String(error));
        }
      }),
    );
  }

  log.info(`crawl complete: ${ok} ok, ${failed} failed/skipped`);
  return { ok, failed };
}

/** Which domains are defeating tiers A and B - i.e. worth an adapter. */
export async function extractionReport(): Promise<void> {
  const rows = await query<{ domain: string; failures: number; total: number }>(
    `select s.domain,
            count(*) filter (where r.extractor = 'none') as failures,
            count(*)                                     as total
       from crawler.raw_pages r
       join crawler.sources s on s.id = r.source_id
      group by s.domain
      having count(*) filter (where r.extractor = 'none') > 0
      order by failures desc`,
  );
  if (rows.length === 0) {
    console.log('No extraction failures. No site adapters needed yet.');
    return;
  }
  console.log('Domains where tiers A+B failed (write an adapter for the top ones):\n');
  for (const row of rows) {
    console.log(`  ${String(row.failures).padStart(5)} / ${String(row.total).padEnd(5)}  ${row.domain}`);
  }
}
