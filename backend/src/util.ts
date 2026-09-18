import { createHash } from 'node:crypto';

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|source|igshid)/i;

/**
 * Collapse the many URLs that point at the same recipe into one key: strip the
 * fragment, tracking params, trailing slash, and default ports. This is what
 * stops the same recipe being ingested five times from five share links.
 *
 * The host is lowercased but otherwise left alone, `www.` included. A canonical
 * URL is also the URL we fetch, and the two spellings are not interchangeable
 * on the wire: food.com 301s every path to its homepage, so rewriting
 * www.food.com/recipe/falafel-293197 to the apex host turns a live recipe into
 * a redirect away from one. Collapsing the two spellings belongs in `urlHash`,
 * which is only ever a key.
 */
export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.username = '';
  url.password = '';
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  if ((url.port === '80' || url.port === '443')) url.port = '';

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The de-duplication key for a URL. `www.` is dropped here rather than in
 * `canonicalizeUrl` so that both spellings of a page share one queue row and
 * one stored page, while each row keeps the spelling that actually serves it.
 */
export function urlHash(url: string): string {
  return sha256(stripWww(canonicalizeUrl(url)));
}

/** The host a URL belongs to, for grouping: robots, crawl delay, adapters. */
export function domainOf(url: string): string {
  return new URL(canonicalizeUrl(url)).hostname.replace(/^www\./, '');
}

/**
 * Hosts whose registrable name is the last three labels rather than the last
 * two. Not a public suffix list - just enough of one to stop `otherHostSpelling`
 * proposing `www.blog.example.co.uk` for a host that is already a subdomain.
 */
const TWO_PART_SUFFIX = /\.(co|com|net|org|gov|edu|ac|or|ne)\.[a-z]{2}$/;

/**
 * The same URL spelled with the other host prefix: `www.` removed if present,
 * added if the host is a bare registrable domain. Null when there is no second
 * spelling worth trying, which is any host that is already a subdomain of
 * something other than `www`.
 *
 * The two spellings are usually interchangeable, but "usually" is the problem:
 * food.com 301s every path to its homepage while www.food.com serves it, and
 * other sites do the reverse. Which one works is a property of the site, not
 * something a URL can be normalized into, so the crawler tries the other one
 * when the first fails rather than guessing up front.
 */
export function otherHostSpelling(input: string): string | null {
  const url = new URL(input);
  const host = url.hostname;

  if (host.startsWith('www.')) {
    url.hostname = host.slice(4);
    return url.toString();
  }

  const labels = host.split('.').length;
  const bare = TWO_PART_SUFFIX.test(host) ? labels === 3 : labels === 2;
  if (!bare) return null;

  url.hostname = `www.${host}`;
  return url.toString();
}

/** The same URL spelled without `www.`, for keys and host comparisons. */
function stripWww(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/^www\./, '');
  return parsed.toString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Decode the HTML entities that survive text extraction. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
