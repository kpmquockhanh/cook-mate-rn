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

export async function fetchPage(url: string, sourceDelayMs?: number): Promise<FetchResult> {
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
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(env.crawlTimeoutMs),
  });

  if (!response.ok) {
    log.warn(`${response.status} ${url}`);
    return { status: response.status, html: null, finalUrl: response.url || url };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html')) {
    return { status: response.status, html: null, finalUrl: response.url || url };
  }

  return { status: response.status, html: await response.text(), finalUrl: response.url || url };
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
