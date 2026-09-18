import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('robots');

export interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
  /** Absolute `Sitemap:` URLs. A non-group field, so it applies to every agent. */
  sitemaps: string[];
}

/**
 * One `user-agent` block and the rules that follow it. A run of consecutive
 * `User-agent:` lines shares one group - that is what makes
 *
 *   User-agent: *
 *   User-agent: Googlebot
 *   Disallow: /
 *
 * a single rule addressed to both, rather than two groups of which only the
 * last has any rules.
 */
interface Group {
  agents: string[];
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
}

const cache = new Map<string, Promise<RobotsRules>>();

/** Test seam: the cache is process-lifetime and keyed by origin. */
export function resetRobotsCache(): void {
  cache.clear();
}

/**
 * The product token we answer to, per RFC 9309: the leading name of the
 * user-agent string, without the version or the parenthesised contact info.
 * `CookMateBot/1.0 (+https://...)` answers to `cookmatebot` and to nothing else.
 */
export function productToken(userAgent: string): string {
  return userAgent.trim().split(/[/\s]/)[0]!.toLowerCase();
}

/**
 * Pick the group that applies to us. RFC 9309 is specific here: a crawler obeys
 * the group matching its own product token, and falls back to `*` only when no
 * such group exists. It does NOT obey the union of both - a site that relaxes a
 * global rule for a named bot means the relaxation to win, and OR-ing the two
 * together would silently re-impose the rule it lifted.
 */
function selectGroup(groups: Group[], token: string): Group {
  const own = groups.filter((group) => group.agents.includes(token));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes('*'));

  // Several records naming the same token are merged, which robots.txt files
  // in the wild do rely on.
  return chosen.reduce<Group>(
    (merged, group) => ({
      agents: [...merged.agents, ...group.agents],
      disallow: [...merged.disallow, ...group.disallow],
      allow: [...merged.allow, ...group.allow],
      crawlDelayMs: group.crawlDelayMs ?? merged.crawlDelayMs,
    }),
    { agents: [], disallow: [], allow: [], crawlDelayMs: null },
  );
}

/**
 * Parse a robots.txt body into the rules that apply to `token`. Pure, so the
 * politeness decisions are testable without a network round trip.
 */
export function parseRobots(body: string, origin: string, token: string): RobotsRules {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  // True while we are inside a run of `User-agent:` lines. The first rule line
  // closes the header, so a later `User-agent:` starts a new group.
  let readingHeader = false;

  for (const line of body.split(/\r?\n/)) {
    const clean = line.split('#')[0]!.trim();
    if (!clean) continue;
    const separator = clean.indexOf(':');
    if (separator === -1) continue;
    const field = clean.slice(0, separator).trim().toLowerCase();
    const value = clean.slice(separator + 1).trim();

    // `Sitemap` is a non-group field: it belongs to the file, not to the
    // user-agent block it happens to sit in, so it is read unconditionally.
    if (field === 'sitemap') {
      try {
        sitemaps.push(new URL(value, origin).toString());
      } catch {
        log.debug(`ignoring unparseable Sitemap entry in ${origin}/robots.txt: ${value}`);
      }
      continue;
    }

    if (field === 'user-agent') {
      if (!current || !readingHeader) {
        current = { agents: [], disallow: [], allow: [], crawlDelayMs: null };
        groups.push(current);
        readingHeader = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    // A rule before any user-agent line belongs to no group; ignore it.
    if (!current) continue;
    readingHeader = false;

    // An empty `Disallow:` means "nothing is disallowed". It carries no pattern,
    // but it still closes the header, which is why it is handled and not skipped.
    if (field === 'disallow' && value) current.disallow.push(value);
    if (field === 'allow' && value) current.allow.push(value);
    if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) current.crawlDelayMs = Math.round(seconds * 1000);
    }
  }

  const group = selectGroup(groups, token);
  return {
    disallow: group.disallow,
    allow: group.allow,
    crawlDelayMs: group.crawlDelayMs,
    sitemaps,
  };
}

/**
 * Deliberately small robots.txt reader. A fetch failure is treated as
 * "allowed", which matches how the major crawlers behave, but a 4xx/5xx is
 * logged.
 */
async function loadRules(origin: string): Promise<RobotsRules> {
  const empty: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null, sitemaps: [] };
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': env.userAgent },
      signal: AbortSignal.timeout(env.crawlTimeoutMs),
    });
    if (!response.ok) {
      log.debug(`${origin}/robots.txt returned ${response.status}; treating as permissive`);
      return empty;
    }
    return parseRobots(await response.text(), origin, productToken(env.userAgent));
  } catch (error) {
    log.debug(`could not read ${origin}/robots.txt`, String(error));
    return empty;
  }
}

/**
 * robots.txt path matching: `*` is any run of characters and a trailing `$`
 * anchors the end. Everything else is a literal prefix match, so `/private`
 * covers `/private/recipes` without needing a wildcard.
 */
export function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/** Longest matching rule wins; Allow beats Disallow at equal length. */
export function isAllowedBy(rules: RobotsRules, path: string): boolean {
  let verdict = true;
  let bestLength = -1;
  for (const pattern of rules.disallow) {
    if (matches(pattern, path) && pattern.length > bestLength) {
      bestLength = pattern.length;
      verdict = false;
    }
  }
  for (const pattern of rules.allow) {
    if (matches(pattern, path) && pattern.length >= bestLength) {
      bestLength = pattern.length;
      verdict = true;
    }
  }
  return verdict;
}

export async function robotsFor(url: string): Promise<RobotsRules> {
  const origin = new URL(url).origin;
  let entry = cache.get(origin);
  if (!entry) {
    entry = loadRules(origin);
    cache.set(origin, entry);
  }
  return entry;
}

export async function isAllowed(url: string): Promise<boolean> {
  const rules = await robotsFor(url);
  const parsed = new URL(url);
  return isAllowedBy(rules, parsed.pathname + parsed.search);
}
