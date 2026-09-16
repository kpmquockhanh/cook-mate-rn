import { createHash } from 'node:crypto';

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|source|igshid)/i;

/**
 * Collapse the many URLs that point at the same recipe into one key: strip the
 * fragment, tracking params, trailing slash, and default ports. This is what
 * stops the same recipe being ingested five times from five share links.
 */
export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.username = '';
  url.password = '';
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
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

export function urlHash(url: string): string {
  return sha256(canonicalizeUrl(url));
}

export function domainOf(url: string): string {
  return new URL(canonicalizeUrl(url)).hostname;
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
