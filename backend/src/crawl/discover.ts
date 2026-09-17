import * as cheerio from 'cheerio';
import { logger } from '../log.js';
import { canonicalizeUrl, domainOf } from '../util.js';
import { extractRecipe } from './extract.js';
import { fetchPage, fetchText } from './fetcher.js';
import { isAllowed, robotsFor } from './robots.js';
import { enqueue, ingestFetchedPage } from './run.js';

const log = logger('discover');

// ---------------------------------------------------------------------------
// URL classification
//
// Discovery's whole job is deciding, from a link alone, whether a URL is worth
// spending a fetch on. Three verdicts:
//
//   recipe  a path segment names the site's recipe section AND the last segment
//           is a slug. High confidence - queue it without spending a fetch.
//   maybe   slug-like, but nothing says what it is. This is where the fetch
//           budget goes: the fetch settles the question, and if it turns out to
//           be a recipe the HTML is ingested rather than discarded.
//   hub     an index/listing page. Worth following for links, not a recipe.
//   skip    an asset, or a part of the site no recipe lives in.
// ---------------------------------------------------------------------------

const RECIPE_HINT =
  /^(recipe|recipes|receta|recetas|ricetta|ricette|rezept|rezepte|recept|recepten|resep|resepi|cong-thuc|mon-ngon|mon-an|cach-lam|nau-an|dish|dishes|cooking|kitchen)$/i;

// A taxonomy segment always introduces a listing: whatever follows `/category/`
// or `/tag/` names the listing, never a recipe. This outranks the recipe hint,
// so `/recipes/category/quick-dinners` is a hub and not a recipe called
// "quick dinners".
const TAXONOMY_SEGMENT =
  /^(category|categories|categorie|kategorie|tag|tags|topic|topics|collection|collections|cuisine|cuisines|course|courses|browse|index|archive|archives|gallery|diet|season|seasons|occasion|occasions|holiday|holidays)$/i;

// A container that can legitimately hold a recipe. Only a listing when the tail
// is not itself a slug - `/blog` is an index, `/blog/sourdough-starter` is not.
const SECTION_SEGMENT =
  /^(blog|articles|article|posts?|page|pages|all|meal|meals|ingredient|ingredients)$/i;

const SKIP_SEGMENT =
  /^(wp-admin|wp-json|wp-content|wp-includes|xmlrpc\.php|login|log-in|signin|sign-in|signup|sign-up|register|account|accounts|my|cart|checkout|order|orders|privacy|privacy-policy|terms|tos|disclaimer|cookie-policy|contact|contact-us|about|about-us|author|authors|user|users|profile|subscribe|newsletter|shop|store|product|products|feed|rss|atom|comment|comments|print|amp|search|go|out|redirect|ads|advertise|jobs|careers|press|sitemap)$/i;

const ASSET_EXTENSION =
  /\.(jpe?g|png|gif|svg|webp|avif|bmp|ico|pdf|zip|gz|rar|mp3|mp4|m4a|mov|avi|webm|css|js|mjs|json|rss|atom|txt|doc|docx|xls|xlsx)$/i;

export type UrlClass = 'recipe' | 'maybe' | 'hub' | 'skip';

export function classifyUrl(input: string): UrlClass {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return 'skip';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'skip';

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return 'hub';

  const last = segments[segments.length - 1]!;
  if (ASSET_EXTENSION.test(last)) return 'skip';
  if (segments.some((segment) => SKIP_SEGMENT.test(segment))) return 'skip';

  // A slug: two or more words joined by hyphens, and not a bare id or date.
  const words = last.replace(/\.(html?|php|aspx?)$/i, '').split('-').filter(Boolean);
  const slugLike = words.length >= 2 && words.some((word) => /[a-z]{3,}/i.test(word));

  if (segments.some((segment) => TAXONOMY_SEGMENT.test(segment))) return 'hub';
  if (segments.some((segment) => SECTION_SEGMENT.test(segment)) && !slugLike) return 'hub';

  if (segments.some((segment) => RECIPE_HINT.test(segment)) && slugLike) return 'recipe';
  if (slugLike) return 'maybe';
  return 'hub';
}

// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  /**
   * `sitemap` reads the site's own index and never crawls. `links` walks the
   * site from the seed. `auto` tries the sitemap first and falls back to the
   * link walk when it comes back empty, which is what you want for a homepage
   * you know nothing about.
   */
  mode?: 'auto' | 'sitemap' | 'links';
  /** Fetch budget for the link walk. The single knob that bounds the run. */
  maxPages?: number;
  maxDepth?: number;
  maxResults?: number;
  /** Fetch every high-confidence candidate too, instead of trusting the URL. */
  verify?: boolean;
  /** Find and report, but write nothing to the database. */
  dryRun?: boolean;
  /** Follow links to `blog.example.com` from `example.com`. */
  includeSubdomains?: boolean;
  /** Extra caller-supplied filters, as regular-expression sources. */
  include?: string;
  exclude?: string;
  signal?: AbortSignal;
}

export interface Candidate {
  url: string;
  /** How it was found: the site's sitemap, a link on a page, or the page itself. */
  via: 'sitemap' | 'link' | 'page';
  /** True only when we fetched it and found recipe markup. */
  verified: boolean;
  title?: string;
  depth: number;
}

export interface DiscoverResult {
  seed: string;
  domain: string;
  mode: 'sitemap' | 'links';
  pagesFetched: number;
  candidates: Candidate[];
  /** Verified pages written straight to raw_pages - no second fetch needed. */
  ingested: number;
  /** Unverified candidates added to the crawl queue. */
  enqueued: number;
  alreadyKnown: number;
  stoppedBecause: string;
}

const SITEMAP_FILE_BUDGET = 25;
const SITEMAP_URL_BUDGET = 50_000;

function hostMatches(candidate: string, seedDomain: string, includeSubdomains: boolean): boolean {
  let host: string;
  try {
    host = domainOf(candidate);
  } catch {
    return false;
  }
  if (host === seedDomain) return true;
  return includeSubdomains && host.endsWith(`.${seedDomain}`);
}

function compile(source: string | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    throw new Error(`invalid filter pattern "${source}": ${String(error)}`);
  }
}

/**
 * Split one sitemap document into the child indexes it points at and the page
 * URLs it lists. A `sitemapindex` lists other sitemaps; a `urlset` lists pages.
 */
export function parseSitemap(xml: string): { nested: string[]; pageUrls: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const locs = (selector: string) =>
    $(selector)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
  return {
    nested: locs('sitemapindex > sitemap > loc'),
    pageUrls: locs('urlset > url > loc'),
  };
}

/** Read the site's sitemaps, following sitemapindex files one level at a time. */
async function collectSitemapUrls(
  seedUrl: string,
  signal: AbortSignal | undefined,
): Promise<{ urls: string[]; files: number }> {
  const origin = new URL(seedUrl).origin;
  const robots = await robotsFor(seedUrl);

  // robots.txt usually names the canonical host and our guesses are built from
  // the www-stripped seed, so the same document arrives under two spellings.
  // Canonicalizing before de-duplication collapses them into one fetch.
  const normalize = (value: string) => {
    try {
      return canonicalizeUrl(value);
    } catch {
      return null;
    }
  };
  const pending = [
    ...new Set(
      [...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]
        .map(normalize)
        .filter((value): value is string => value !== null),
    ),
  ];
  const seen = new Set<string>(pending);
  const urls: string[] = [];
  let files = 0;

  while (pending.length > 0 && files < SITEMAP_FILE_BUDGET && urls.length < SITEMAP_URL_BUDGET) {
    if (signal?.aborted) break;
    const target = pending.shift()!;

    let body: string | null = null;
    try {
      const result = await fetchText(target, undefined, 'application/xml,text/xml,text/plain');
      body = result.body;
      files++;
      if (!body) {
        log.debug(`sitemap ${target} -> HTTP ${result.status}`);
        continue;
      }
    } catch (error) {
      log.debug(`sitemap ${target} failed: ${String(error)}`);
      continue;
    }

    // Gzipped sitemaps arrive as bytes we cannot read as text; skip rather than
    // pretend. `.xml.gz` is common enough to be worth saying so out loud.
    if (target.endsWith('.gz')) {
      log.warn(`skipping gzipped sitemap (not supported): ${target}`);
      continue;
    }

    const { nested, pageUrls } = parseSitemap(body);
    for (const child of nested) {
      const normalized = normalize(child);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        pending.push(normalized);
      }
    }
    urls.push(...pageUrls);

    if (nested.length || pageUrls.length) {
      log.info(`sitemap ${target}: ${pageUrls.length} url(s), ${nested.length} nested index(es)`);
    }
  }

  return { urls, files };
}

/** Every link on a page, resolved against it, canonicalized and de-duplicated. */
export function extractLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      out.add(canonicalizeUrl(new URL(href, pageUrl).toString()));
    } catch {
      /* unparseable href - ignore */
    }
  });
  return [...out];
}

function titleOf(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  return match[1]!.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
}

/**
 * Turn one seed URL - typically a homepage - into a list of recipe URLs.
 *
 * Politeness is not re-implemented here: every fetch goes through the same
 * per-host gate and robots.txt reader the crawl stage uses, so exploring a site
 * is exactly as slow and exactly as well-behaved as crawling it.
 */
export async function discover(
  seedInput: string,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const seed = canonicalizeUrl(seedInput);
  const domain = domainOf(seed);
  const {
    mode = 'auto',
    maxPages = 40,
    maxDepth = 2,
    maxResults = 200,
    verify = false,
    dryRun = false,
    includeSubdomains = false,
    signal,
  } = options;

  const include = compile(options.include);
  const exclude = compile(options.exclude);
  const allowed = (url: string) =>
    hostMatches(url, domain, includeSubdomains) &&
    (!include || include.test(url)) &&
    (!exclude || !exclude.test(url));

  const candidates = new Map<string, Candidate>();
  let pagesFetched = 0;
  let stoppedBecause = 'exhausted';
  let usedMode: 'sitemap' | 'links' = 'links';

  const record = (candidate: Candidate) => {
    const existing = candidates.get(candidate.url);
    // A verified hit always replaces a guess.
    if (!existing || (candidate.verified && !existing.verified)) {
      candidates.set(candidate.url, candidate);
    }
  };

  // --- sitemap -------------------------------------------------------------
  if (mode === 'sitemap' || mode === 'auto') {
    log.info(`reading sitemaps for ${domain}`);
    const sitemap = await collectSitemapUrls(seed, signal);
    pagesFetched += sitemap.files;
    // A large site lists the same URL in more than one sitemap; de-duplicate
    // before the result cap, or `maxResults` silently returns fewer than it says.
    const urls = [
      ...new Set(
        sitemap.urls
          .map((url) => {
            try {
              return canonicalizeUrl(url);
            } catch {
              return null;
            }
          })
          .filter((url): url is string => url !== null && allowed(url)),
      ),
    ];

    // Prefer the URLs the site itself marks as recipes. Only when a site has no
    // such convention at all do we fall back to every slug-shaped URL, which is
    // noisier but is the only signal left.
    const strong = urls.filter((url) => classifyUrl(url) === 'recipe');
    const chosen = strong.length > 0 ? strong : urls.filter((url) => classifyUrl(url) === 'maybe');

    for (const url of chosen.slice(0, maxResults)) {
      record({ url, via: 'sitemap', verified: false, depth: 0 });
    }

    // `verify` means "do not take the URL's word for it". In the link walk that
    // falls out of the walk itself; here it is an explicit pass, bounded by the
    // same fetch budget, that keeps only the pages carrying recipe markup.
    if (verify && candidates.size > 0) {
      const toCheck = [...candidates.values()].slice(0, maxPages);
      const unchecked = candidates.size - toCheck.length;
      log.info(`verifying ${toCheck.length} of ${candidates.size} candidate(s)`);
      for (const candidate of toCheck) {
        if (signal?.aborted) {
          stoppedBecause = 'cancelled';
          break;
        }
        if (!(await isAllowed(candidate.url))) {
          candidates.delete(candidate.url);
          continue;
        }
        try {
          const result = await fetchPage(candidate.url);
          pagesFetched++;
          const recipe = result.html ? extractRecipe(result.html, candidate.url).recipe : null;
          if (!recipe) {
            candidates.delete(candidate.url);
            continue;
          }
          record({ ...candidate, verified: true, title: recipe.name ?? titleOf(result.html!) });
          if (!dryRun) await ingestFetchedPage(candidate.url, result.html!, result.status);
        } catch (error) {
          log.warn(`verify failed: ${candidate.url}`, String(error));
          candidates.delete(candidate.url);
        }
      }
      log.info(
        `${candidates.size - unchecked} of ${toCheck.length} checked carried recipe markup` +
          (unchecked ? `; ${unchecked} left unchecked by the page budget` : ''),
      );
    }

    if (candidates.size > 0) {
      usedMode = 'sitemap';
      stoppedBecause = 'sitemap read in full';
      log.info(
        `sitemap gave ${candidates.size} candidate(s) from ${urls.length} url(s)` +
          (strong.length === 0 ? ' (no /recipe/-style paths; used slug shape instead)' : ''),
      );
    } else if (mode === 'sitemap') {
      usedMode = 'sitemap';
      stoppedBecause = 'sitemap had no recipe-shaped urls';
    } else {
      log.info('sitemap gave nothing usable - walking links instead');
    }
  }

  // --- link walk -----------------------------------------------------------
  if (candidates.size === 0 && mode !== 'sitemap') {
    usedMode = 'links';

    // Two queues, not one. A homepage's links start with its navigation, so a
    // plain FIFO walk spends the whole fetch budget on "About" and category
    // listings before it reaches a single recipe. Pages that might themselves
    // be recipes are drained first; hubs are the fallback, read for their links
    // when nothing more promising is waiting.
    const likely: { url: string; depth: number }[] = [];
    const hubs: { url: string; depth: number }[] = [{ url: seed, depth: 0 }];
    const next = () => likely.shift() ?? hubs.shift();
    const seen = new Set<string>([seed]);
    let banked = 0;

    while (likely.length + hubs.length > 0) {
      if (signal?.aborted) {
        stoppedBecause = 'cancelled';
        break;
      }
      if (pagesFetched >= maxPages) {
        stoppedBecause = `page budget reached (${maxPages})`;
        break;
      }
      if (candidates.size >= maxResults) {
        stoppedBecause = `result limit reached (${maxResults})`;
        break;
      }

      const { url, depth } = next()!;

      if (!(await isAllowed(url))) {
        log.debug(`robots.txt disallows ${url}`);
        continue;
      }

      let html: string | null = null;
      let status = 0;
      try {
        const result = await fetchPage(url);
        html = result.html;
        status = result.status;
        pagesFetched++;
      } catch (error) {
        log.warn(`fetch failed: ${url}`, String(error));
        continue;
      }
      if (!html) continue;

      // The fetch already happened, so ask the real extractors rather than the
      // URL heuristic: this page either is a recipe or it is not.
      const { recipe } = extractRecipe(html, url);

      if (recipe) {
        record({
          url,
          via: 'page',
          verified: true,
          title: recipe.name ?? titleOf(html),
          depth,
        });
        if (!dryRun) await ingestFetchedPage(url, html, status);
        log.info(`recipe ${candidates.size}/${maxResults}: ${recipe.name ?? url}`);
        // Recipe pages do link to other recipes ("related"), so their links are
        // still worth reading - the depth limit is what stops the walk.
      }

      let queued = 0;
      for (const link of extractLinks(html, url)) {
        if (seen.has(link) || !allowed(link)) continue;
        const verdict = classifyUrl(link);
        if (verdict === 'skip') continue;

        if (verdict === 'recipe' && !verify) {
          // High confidence and we are not verifying: bank it without a fetch.
          seen.add(link);
          record({ url: link, via: 'link', verified: false, depth: depth + 1 });
          banked++;
          if (candidates.size >= maxResults) break;
          continue;
        }

        if (depth + 1 > maxDepth) continue;
        seen.add(link);
        (verdict === 'maybe' ? likely : hubs).push({ url: link, depth: depth + 1 });
        queued++;
      }

      if (!recipe) {
        log.info(
          `page ${pagesFetched}/${maxPages} (depth ${depth}): no recipe markup, ` +
            `${queued} link(s) to follow, ${banked} banked so far - ${url}`,
        );
      }
    }

    if (likely.length + hubs.length === 0 && stoppedBecause === 'exhausted') {
      stoppedBecause = 'no more links to follow';
    }
  }

  // --- persist -------------------------------------------------------------
  const found = [...candidates.values()];
  const ingested = found.filter((c) => c.verified).length;
  let enqueued = 0;

  const unverified = found.filter((c) => !c.verified).map((c) => c.url);
  if (!dryRun && unverified.length > 0) {
    enqueued = await enqueue(unverified);
  }

  log.info(
    dryRun
      ? `discovery done (preview, nothing written): ${found.length} candidate(s) from ` +
        `${pagesFetched} fetch(es), ${ingested} of them confirmed recipes (${stoppedBecause})`
      : `discovery done: ${found.length} candidate(s) from ${pagesFetched} fetch(es) - ` +
        `${ingested} ingested outright, ${enqueued} queued (${stoppedBecause})`,
  );

  return {
    seed,
    domain,
    mode: usedMode,
    pagesFetched,
    candidates: found,
    ingested: dryRun ? 0 : ingested,
    enqueued,
    alreadyKnown: dryRun ? 0 : unverified.length - enqueued,
    stoppedBecause,
  };
}
