import { query, transaction } from '../db.js';
import { env } from '../env.js';
import { type Run, withRun } from '../jobs/runs.js';
import { logger } from '../log.js';
import { saveRawPageHtml, readRawPage } from '../storage/rawPages.js';
import { canonicalizeUrl, domainOf, otherHostSpelling, sha256, urlHash } from '../util.js';
import { classifyUrl } from './discover.js';
import { type ExtractionOutcome, extractRecipe } from './extract.js';
import { type FetchResult, type Validators, fetchWithRetry } from './fetcher.js';
import { isAllowed } from './robots.js';

const log = logger('crawl');

interface QueueRow {
  id: number;
  url: string;
  url_hash: string;
  source_id: number | null;
  attempts: number;
  etag: string | null;
  last_modified: string | null;
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
      returning q.id, q.url, q.url_hash, q.source_id, q.attempts, q.etag, q.last_modified`,
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

/** Keep what the server gave us, so the next visit can ask "still the same?". */
async function rememberValidators(
  id: number,
  etag: string | null,
  lastModified: string | null,
): Promise<void> {
  if (!etag && !lastModified) return;
  await query(
    `update crawler.crawl_queue set etag = $2, last_modified = $3 where id = $1`,
    [id, etag, lastModified],
  );
}

/**
 * The URL a fetch ended up on, when a redirect took it to a different page that
 * does not look like a recipe; null otherwise. Host changes alone (food.com to
 * www.food.com) and trailing slashes are not a different page.
 */
function redirectedAway(requested: string, final: string): string | null {
  const path = (input: string) => {
    try {
      return new URL(input).pathname.replace(/\/+$/, '').toLowerCase();
    } catch {
      return null;
    }
  };
  if (path(requested) === path(final)) return null;
  const verdict = classifyUrl(final);
  return verdict === 'recipe' || verdict === 'maybe' ? null : final;
}

async function finish(id: number, status: 'done' | 'failed' | 'skipped', error?: string) {
  await query(
    `update crawler.crawl_queue
        set status = $2, last_error = $3, finished_at = now()
      where id = $1`,
    [id, status, error ?? null],
  );
}

interface StoredPage {
  url: string;
  hash: string;
  sourceId: number | null;
  httpStatus: number;
  html: string;
}

/**
 * The one place a fetched page becomes an immutable raw_pages row. Both the
 * queue worker below and discovery (which fetches candidate pages in order to
 * decide whether they are recipes at all) land here, so the extraction tier and
 * the content hash are computed identically no matter who did the fetching.
 */
async function storeRawPage(page: StoredPage): Promise<ExtractionOutcome> {
  const outcome = extractRecipe(page.html, page.url);
  const contentHash = sha256(page.html);

  // The bytes go to object storage first. If that fails the row is never
  // written, so a raw_pages row always points at something that exists - the
  // opposite order would leave rows claiming HTML nobody can read.
  const storagePath = await saveRawPageHtml(contentHash, page.html);

  await query(
    `insert into crawler.raw_pages
       (url, url_hash, source_id, http_status, content_hash, storage_path, extracted, extractor)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (url_hash, content_hash) do update
        -- Only a tier that actually found something may overwrite what is
        -- already there. Re-fetching a page whose content has not changed lands
        -- on this row again with a fresh 'none' from tiers A-C, and blindly
        -- assigning that would erase a Tier D extraction - while leaving
        -- extraction_version stamped, so Tier D would never re-read it either.
        -- The recipe would simply vanish on the first revisit.
        set extracted    = case when excluded.extracted is not null
                                then excluded.extracted else crawler.raw_pages.extracted end,
            extractor    = case when excluded.extracted is not null
                                then excluded.extractor else crawler.raw_pages.extractor end,
            storage_path = excluded.storage_path,
            -- Keep the spelling that most recently worked. url_hash ignores
            -- a www. prefix, so a page first stored under the spelling that
            -- redirects lands on this same row when the working one is
            -- fetched; leaving url alone would publish the dead spelling as
            -- the recipe's source_url, which parse copies from this column.
            url          = excluded.url,
            fetched_at   = now()`,
    [
      page.url,
      page.hash,
      page.sourceId,
      page.httpStatus,
      contentHash,
      storagePath,
      outcome.recipe ? JSON.stringify(outcome.recipe) : null,
      outcome.extractor,
    ],
  );

  return outcome;
}

/**
 * Store a page some other stage has already downloaded, without touching the
 * crawl queue. Discovery uses this for the pages it fetches purely to read
 * their links: they are not recipe candidates and have no business appearing in
 * the queue as failures, but the HTML is still worth keeping rather than
 * downloading again later.
 *
 * Returns whether the page carried recipe markup.
 */
export async function storeFetchedPage(
  rawUrl: string,
  html: string,
  httpStatus: number,
): Promise<boolean> {
  const url = canonicalizeUrl(rawUrl);
  const source = await ensureSource(url);
  const { recipe } = await storeRawPage({
    url,
    hash: urlHash(url),
    sourceId: source.id,
    httpStatus,
    html,
  });
  return recipe !== null;
}

/**
 * Record a page some other stage has already downloaded, as if `crawl` had
 * fetched it: a queue row in its terminal state plus the raw page. Discovery
 * uses this for pages it fetched *as recipe candidates*, so the HTML it had to
 * download anyway is not thrown away and then requested a second time from the
 * same source.
 *
 * A candidate that turns out to carry no recipe markup is still stored. That
 * population - fetched, kept, recognised by nothing - is exactly what an
 * extractor that can read prose has to work from, and discarding it is what
 * used to make reading those pages cost a second crawl.
 *
 * Returns whether the page actually carried recipe markup.
 */
export async function ingestFetchedPage(
  rawUrl: string,
  html: string,
  httpStatus: number,
): Promise<boolean> {
  const url = canonicalizeUrl(rawUrl);
  const hash = urlHash(url);
  const source = await ensureSource(url);

  await query(
    `insert into crawler.crawl_queue (url, url_hash, source_id, status, attempts, locked_at)
     values ($1, $2, $3, 'fetching', 1, now())
     on conflict (url_hash) do nothing`,
    [url, hash, source.id],
  );

  const { recipe } = await storeRawPage({
    url,
    hash,
    sourceId: source.id,
    httpStatus,
    html,
  });

  await query(
    `update crawler.crawl_queue
        set status = $2, last_error = $3, finished_at = now()
      where url_hash = $1`,
    [hash, recipe ? 'done' : 'failed', recipe ? null : 'no recipe markup (tiers A/B/C all missed)'],
  );

  return recipe !== null;
}

/**
 * The most recent stored copy of a page, or null if it was never fetched.
 *
 * Discovery reads this instead of refetching: a page it walked last week still
 * has the links it needs, and the whole point of keeping raw pages is that the
 * source is not asked twice for the same bytes.
 */
export async function storedPage(
  rawUrl: string,
): Promise<{ html: string; httpStatus: number } | null> {
  return readRawPage(rawUrl);
}

/**
 * Which of these URLs the engine has already fetched and kept.
 *
 * `raw_pages` is the right authority rather than the queue: it is the record of
 * what was actually downloaded, it survives queue maintenance, and it is what
 * makes "do not pay for this fetch twice" mean the same thing to discovery and
 * to any later re-extraction pass.
 */
export async function alreadyStored(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();

  const byHash = new Map<string, string>();
  for (const url of urls) {
    try {
      byHash.set(urlHash(url), canonicalizeUrl(url));
    } catch {
      /* unparseable - it will never match a stored row anyway */
    }
  }

  const rows = await query<{ url_hash: string }>(
    `select distinct url_hash from crawler.raw_pages where url_hash = any($1)`,
    [[...byHash.keys()]],
  );

  return new Set(rows.map((row) => byHash.get(row.url_hash)!).filter(Boolean));
}

/**
 * Take back rows a dead worker is still holding.
 *
 * `claim` sets `locked_at` and nothing ever read it, so a process killed
 * mid-batch left its rows in `fetching` permanently: never retried, and not
 * visible as failures either. A row past its lease is either put back or, if it
 * has already used up its attempts, failed - the same budget an error gets.
 */
export async function reclaimStaleLocks(): Promise<number> {
  const rows = await query<{ id: number }>(
    `update crawler.crawl_queue
        set status      = case when attempts >= 3 then 'failed' else 'pending' end,
            last_error  = $2,
            locked_at   = null,
            finished_at = case when attempts >= 3 then now() else null end
      where status = 'fetching'
        and locked_at < now() - make_interval(mins => $1::int)
      returning id`,
    [env.crawlLockLeaseMinutes, `lock expired after ${env.crawlLockLeaseMinutes}m`],
  );
  if (rows.length > 0) log.warn(`reclaimed ${rows.length} stranded queue row(s)`);
  return rows.length;
}

/**
 * Put URLs that are due a revisit back in the queue.
 *
 * `url_hash` is globally unique and `enqueue` is `on conflict do nothing`, so a
 * URL that reached `done` could never be queued again - a recipe edited at its
 * source stayed invisible forever. Resetting the existing row is what reopens
 * it, and the per-source interval is what decides when.
 *
 * Bounded by the same limit as the crawl it precedes, so a large corpus coming
 * due does not turn one run into a full re-crawl. Refreshes take a worse
 * priority than new URLs: discovering something new beats re-reading something
 * we already have.
 */
export async function scheduleRefresh(limit: number): Promise<number> {
  const rows = await query<{ id: number }>(
    `update crawler.crawl_queue
        set status = 'pending', attempts = 0, last_error = null,
            locked_at = null, finished_at = null, priority = 200
      where id in (
        select q.id
          from crawler.crawl_queue q
          join crawler.sources s on s.id = q.source_id
         where q.status = 'done'
           and s.enabled
           and s.recrawl_interval_hours is not null
           and q.finished_at is not null
           and q.finished_at < now() - make_interval(hours => s.recrawl_interval_hours)
         order by q.finished_at
         limit $1
      )
      returning id`,
    [limit],
  );
  if (rows.length > 0) log.info(`${rows.length} url(s) due a revisit`);
  return rows.length;
}

interface SpellingAttempt {
  /** The spelling that produced `result` - not always the one on the row. */
  url: string;
  result: FetchResult;
  /** Where the fetch ended up when that was not a recipe page; null otherwise. */
  landedOn: string | null;
}

/**
 * Fetch a queued URL, falling back to the other `www.` spelling of its host
 * when the first one does not yield a recipe page.
 *
 * A URL typed or pasted by hand, or scraped off a page that links to its own
 * apex domain, routinely carries the spelling the site does not serve: asking
 * food.com for a recipe path gets a 301 to its homepage, while www.food.com
 * serves the recipe. Nothing about the URL says which way round a given site
 * is, so the only honest answer is to try the other one - but only after the
 * first has actually failed, so a healthy crawl costs exactly one request per
 * page as before.
 *
 * Validators are deliberately not sent on the second attempt: they were stored
 * against the first spelling, and a 304 here would leave us with no body to
 * judge the page by.
 */
async function fetchEitherSpelling(
  item: QueueRow,
  delayMs: number | undefined,
  run: Run,
): Promise<SpellingAttempt> {
  const attempt = async (url: string, conditional?: Validators): Promise<SpellingAttempt> => {
    const result = await fetchWithRetry(url, delayMs, 3, conditional);
    run.bump('pages_fetched');
    run.bumpStatus(result.status);
    // A dead recipe URL often 301s to the homepage or a category page rather
    // than returning 404. Following it silently would store that page under the
    // recipe URL, and Tier D would later pay a model to conclude it holds no
    // recipe. A redirect to another recipe (a renamed slug) is still worth
    // reading.
    const landedOn = result.html ? redirectedAway(url, result.finalUrl) : null;
    return { url, result, landedOn };
  };

  const first = await attempt(item.url, {
    etag: item.etag,
    lastModified: item.last_modified,
  });
  const usable = (a: SpellingAttempt) =>
    a.result.notModified || (a.result.html !== null && a.landedOn === null);
  if (usable(first)) return first;

  const other = otherHostSpelling(item.url);
  if (!other) return first;

  // The other spelling is a different origin, so it has its own robots.txt and
  // has never been checked. Skipping this would let the fallback fetch a URL
  // the first spelling's rules happened not to cover.
  if (!(await isAllowed(other))) {
    log.info(`robots.txt disallows the other spelling ${other}`);
    return first;
  }

  log.info(`${item.url} gave nothing; trying ${other}`);
  let second: SpellingAttempt;
  try {
    second = await attempt(other);
  } catch (error) {
    // The guessed host may not resolve at all. That is a failed guess, not a
    // failed item: report what the row's own spelling did.
    log.debug(`other spelling ${other} failed outright: ${String(error)}`);
    return first;
  }

  if (!usable(second)) return first;

  run.bump('host_spelling_corrected');
  return second;
}

async function crawlOne(
  item: QueueRow,
  delays: Map<number, number>,
  run: Run,
): Promise<boolean> {
  if (!(await isAllowed(item.url))) {
    log.info(`robots.txt disallows ${item.url}`);
    await finish(item.id, 'skipped', 'robots.txt disallow');
    run.bump('robots_skipped');
    return false;
  }

  const { url, result, landedOn } = await fetchEitherSpelling(
    item,
    delays.get(item.source_id ?? -1),
    run,
  );

  // Nothing changed since last time. The stored page is still current, so there
  // is no new raw_pages row and nothing downstream to redo - which is the whole
  // point of sending the validators.
  if (result.notModified) {
    log.debug(`304 not modified: ${url}`);
    await finish(item.id, 'done');
    run.bump('unchanged');
    return true;
  }

  if (!result.html) {
    await finish(item.id, 'failed', `HTTP ${result.status} or non-HTML body`);
    run.bump('failed_http_or_non_html');
    return false;
  }

  if (landedOn) {
    log.info(`redirected away from recipe: ${url} -> ${landedOn}`);
    await finish(item.id, 'failed', `redirected to ${landedOn} (not a recipe page)`);
    run.bump('redirected_away');
    return false;
  }

  // The other spelling worked, so the queue should stop asking for the one that
  // does not. `url_hash` ignores `www.`, so rewriting the row cannot collide
  // with anything and keeps every reference to this page intact.
  if (url !== item.url) {
    await query(`update crawler.crawl_queue set url = $2 where id = $1`, [item.id, url]);
    log.info(`queue row now points at ${url}`);
  }

  await rememberValidators(item.id, result.etag, result.lastModified);

  const { recipe, extractor } = await storeRawPage({
    url,
    hash: item.url_hash,
    sourceId: item.source_id,
    httpStatus: result.status,
    html: result.html,
  });

  run.bump(`extractor_${extractor.startsWith('adapter:') ? 'adapter' : extractor}`);

  if (!recipe) {
    // Not a dead end: the page is stored, and Tier D reads exactly this
    // population. Saying so matters because the queue row goes to 'failed',
    // which on its own reads like the page was lost.
    log.info(`no structured markup, kept for \`extract\`: ${url}`);
    await finish(item.id, 'failed', 'no structured markup (tiers A/B/C missed) - awaiting extract');
    run.bump('failed_no_markup');
    return false;
  }

  log.info(`${extractor} -> ${recipe.name ?? '(untitled)'} (${recipe.recipeIngredient?.length ?? 0} ingredients)`);
  await finish(item.id, 'done');
  return true;
}

export async function crawl(limit: number): Promise<{ ok: number; failed: number }> {
  return withRun('crawl', { limit }, (run) => crawlWithin(limit, run));
}

async function crawlWithin(limit: number, run: Run): Promise<{ ok: number; failed: number }> {
  // Both run before anything is claimed: a stranded row is work already paid
  // for and worth recovering first, and a due revisit should compete for this
  // run's budget rather than waiting for a command nobody remembers to run.
  run.bump('locks_reclaimed', await reclaimStaleLocks());
  run.bump('refreshed', await scheduleRefresh(limit));

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
          run.bump('source_disabled');
          return;
        }
        try {
          if (await crawlOne(item, delays, run)) ok++;
          else failed++;
        } catch (error) {
          failed++;
          log.error(`crawl failed: ${item.url}`, String(error));
          await requeueOrFail(item, String(error));
          run.bump('failed_error');
        }
      }),
    );
  }

  run.bump('ok', ok);
  run.bump('failed', failed);
  log.info(`crawl complete: ${ok} ok, ${failed} failed/skipped`);

  const unread = run.snapshot().failed_no_markup ?? 0;
  if (unread > 0) {
    log.info(
      `${unread} page(s) carried no structured markup and are stored unread - ` +
        'run `npm run extract -- --dry-run` to see what a model can read off them',
    );
  }
  return { ok, failed };
}

/**
 * Re-evaluate everything already in the queue against the current robots.txt
 * rules, and report - never mutate.
 *
 * Correcting the `$` anchor, the product-token match and the group scoping made
 * the crawler strictly *more* restricted, so URLs that were fetched happily
 * under the old reading may now be disallowed. Those are worth seeing as a list
 * before the next crawl silently skips them, because for a `done` row it also
 * means the stored page was fetched under a rule we were misreading.
 */
export async function robotsAudit(limit: number): Promise<void> {
  const rows = await query<{ url: string; status: string }>(
    `select url, status from crawler.crawl_queue
      where status in ('pending', 'done')
      order by id
      limit $1`,
    [limit],
  );

  if (rows.length === 0) {
    console.log('Nothing in the queue to audit.');
    return;
  }

  const blocked = new Map<string, { url: string; status: string }[]>();
  let checked = 0;

  for (const row of rows) {
    try {
      if (await isAllowed(row.url)) continue;
      const domain = domainOf(row.url);
      const list = blocked.get(domain) ?? [];
      list.push(row);
      blocked.set(domain, list);
    } catch (error) {
      log.warn(`could not evaluate ${row.url}`, String(error));
    }
    checked++;
  }

  if (blocked.size === 0) {
    console.log(`Checked ${rows.length} queued URL(s). None are disallowed under current rules.`);
    return;
  }

  console.log(
    `${checked} of ${rows.length} queued URL(s) are disallowed under current robots.txt rules:\n`,
  );
  for (const [domain, list] of [...blocked.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const alreadyFetched = list.filter((row) => row.status === 'done').length;
    console.log(
      `  ${domain}  -  ${list.length} disallowed` +
        (alreadyFetched ? `, ${alreadyFetched} of them already fetched` : ''),
    );
    for (const row of list.slice(0, 10)) console.log(`      ${row.status.padEnd(8)} ${row.url}`);
    if (list.length > 10) console.log(`      ... and ${list.length - 10} more`);
  }
  console.log(
    '\nNothing was changed. `crawl` will skip the pending ones; decide for yourself what to do\n' +
      'about any already fetched.',
  );
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
