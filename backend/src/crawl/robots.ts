import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('robots');

interface RobotsRules {
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
}

const cache = new Map<string, Promise<RobotsRules>>();

/**
 * Deliberately small robots.txt reader: it honours Disallow/Allow/Crawl-delay
 * for our own user-agent and for `*`. A fetch failure is treated as "allowed",
 * which matches how the major crawlers behave, but a 4xx/5xx is logged.
 */
async function loadRules(origin: string): Promise<RobotsRules> {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: null };
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': env.userAgent },
      signal: AbortSignal.timeout(env.crawlTimeoutMs),
    });
    if (!response.ok) {
      log.debug(`${origin}/robots.txt returned ${response.status}; treating as permissive`);
      return rules;
    }
    const body = await response.text();

    let applies = false;
    for (const line of body.split(/\r?\n/)) {
      const clean = line.split('#')[0]!.trim();
      if (!clean) continue;
      const separator = clean.indexOf(':');
      if (separator === -1) continue;
      const field = clean.slice(0, separator).trim().toLowerCase();
      const value = clean.slice(separator + 1).trim();

      if (field === 'user-agent') {
        const agent = value.toLowerCase();
        applies = agent === '*' || env.userAgent.toLowerCase().startsWith(agent);
        continue;
      }
      if (!applies) continue;
      if (field === 'disallow' && value) rules.disallow.push(value);
      if (field === 'allow' && value) rules.allow.push(value);
      if (field === 'crawl-delay') {
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds)) rules.crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  } catch (error) {
    log.debug(`could not read ${origin}/robots.txt`, String(error));
  }
  return rules;
}

function matches(pattern: string, path: string): boolean {
  // robots.txt wildcards: `*` = any run of chars, `$` = end anchor.
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const anchored = escaped.endsWith('$') ? `^${escaped}` : `^${escaped}`;
  return new RegExp(anchored).test(path);
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
  const path = new URL(url).pathname + new URL(url).search;

  // Longest matching rule wins; Allow beats Disallow at equal length.
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
