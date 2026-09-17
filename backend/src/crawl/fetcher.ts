import { env } from '../env.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { robotsFor } from './robots.js';

const log = logger('fetch');

/** Per-host serialization: one in-flight request per host, spaced by the delay. */
const hostGate = new Map<string, Promise<void>>();

async function waitTurn(host: string, delayMs: number): Promise<void> {
  const previous = hostGate.get(host) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostGate.set(
    host,
    previous.then(() => current),
  );
  await previous;
  setTimeout(release, delayMs);
}

export interface FetchResult {
  status: number;
  html: string | null;
  finalUrl: string;
}

export interface TextFetchResult {
  status: number;
  body: string | null;
  contentType: string;
  finalUrl: string;
}

/**
 * Fetch a document of any type, through the same per-host gate as page fetches.
 * Sitemaps are XML, so discovery cannot go through `fetchPage`, but it must
 * still queue behind the crawl delay like every other request to that host.
 */
export async function fetchText(
  url: string,
  sourceDelayMs?: number,
  accept = 'text/html,application/xhtml+xml',
): Promise<TextFetchResult> {
  const host = new URL(url).hostname;
  const robots = await robotsFor(url);
  const delay = Math.max(
    sourceDelayMs ?? env.crawlDefaultDelayMs,
    robots.crawlDelayMs ?? 0,
  );
  await waitTurn(host, delay);

  const response = await fetch(url, {
    headers: {
      'user-agent': env.userAgent,
      accept,
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(env.crawlTimeoutMs),
  });

  const contentType = response.headers.get('content-type') ?? '';
  const finalUrl = response.url || url;

  if (!response.ok) {
    log.warn(`${response.status} ${url}`);
    return { status: response.status, body: null, contentType, finalUrl };
  }

  return { status: response.status, body: await response.text(), contentType, finalUrl };
}

export async function fetchPage(url: string, sourceDelayMs?: number): Promise<FetchResult> {
  const result = await fetchText(url, sourceDelayMs);
  const isHtml = result.body !== null && result.contentType.includes('html');
  return {
    status: result.status,
    html: isHtml ? result.body : null,
    finalUrl: result.finalUrl,
  };
}

/** Retry wrapper with exponential backoff; only retries transient failures. */
export async function fetchWithRetry(
  url: string,
  sourceDelayMs?: number,
  attempts = 3,
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fetchPage(url, sourceDelayMs);
      // 4xx other than 429 will not get better on retry.
      if (result.status >= 400 && result.status < 500 && result.status !== 429) return result;
      if (result.status < 400) return result;
      lastError = new Error(`HTTP ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(1000 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
