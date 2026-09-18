import { env } from '../env.js';
import { logger } from '../log.js';
import { sleep } from '../util.js';
import { robotsFor } from './robots.js';

const log = logger('fetch');

/** Per-host serialization: one in-flight request per host, spaced by the delay. */
const hostGate = new Map<string, Promise<void>>();

/**
 * When a host asked us to back off, and until when.
 *
 * A 429 or 503 carrying `Retry-After` is the clearest signal a crawler ever
 * gets, and honouring it only on the retry of *that* request would keep hammering
 * the host with every other URL queued behind it. Recording it per host closes
 * the host for everyone.
 */
const hostPenalty = new Map<string, number>();

function penaltyRemaining(host: string): number {
  const until = hostPenalty.get(host);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    hostPenalty.delete(host);
    return 0;
  }
  return remaining;
}

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();

  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds) && /^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function noteRetryAfter(host: string, response: Response): void {
  if (response.status !== 429 && response.status !== 503) return;
  const wait = parseRetryAfter(response.headers.get('retry-after'));
  if (wait === null) return;

  const capped = Math.min(wait, env.crawlMaxRetryAfterMs);
  hostPenalty.set(host, Date.now() + capped);
  log.warn(`${host} asked for ${Math.round(capped / 1000)}s of back-off (HTTP ${response.status})`);
}

/** Test seam: forget per-host pacing state. */
export function resetHostState(): void {
  hostGate.clear();
  hostPenalty.clear();
}

/**
 * Run `task` as this host's only in-flight request, and hold the host closed
 * for `delayMs` after it finishes.
 *
 * The delay is measured from completion, not from the moment the turn was
 * granted. Measuring it from the start means a response slower than the delay
 * releases the gate while it is still in flight, which is how a "2 second crawl
 * delay" quietly becomes several concurrent requests against a slow site -
 * exactly the site least able to absorb them.
 *
 * The caller is handed the task's result immediately; only the *next* request
 * to that host waits out the delay.
 */
async function withHostTurn<T>(host: string, delayMs: number, task: () => Promise<T>): Promise<T> {
  const previous = hostGate.get(host) ?? Promise.resolve();
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  // A failed request must still open the gate behind it, or one thrown error
  // strands every request queued behind it for the life of the process.
  hostGate.set(
    host,
    previous.then(() => gate),
  );

  await previous;
  // A back-off asked for while this request was queued applies before it runs,
  // not only to whatever comes after it.
  const owed = penaltyRemaining(host);
  if (owed > 0) await sleep(owed);

  try {
    return await task();
  } finally {
    // The task may have just been told to back off; that outranks the delay.
    setTimeout(openGate, Math.max(delayMs, penaltyRemaining(host)));
  }
}

/**
 * What a previous fetch of this URL learned, so the server can answer "nothing
 * changed" instead of sending the page again.
 */
export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchResult {
  status: number;
  html: string | null;
  finalUrl: string;
  /** Validators to store for next time. Absent when the server sent none. */
  etag: string | null;
  lastModified: string | null;
  /** The server answered 304: the copy we hold is still current. */
  notModified: boolean;
}

export interface TextFetchResult {
  status: number;
  body: string | null;
  contentType: string;
  finalUrl: string;
}

export interface BytesFetchResult {
  status: number;
  bytes: Uint8Array | null;
  contentType: string;
  finalUrl: string;
}

/**
 * One request through the per-host gate, with the caller deciding how to read
 * the body. Reading is part of the request: the turn is not over until the
 * connection is, so `read` runs inside the gate rather than after it.
 */
interface RequestResult<T> {
  status: number;
  value: T | null;
  contentType: string;
  finalUrl: string;
  etag: string | null;
  lastModified: string | null;
}

async function request<T>(
  url: string,
  sourceDelayMs: number | undefined,
  accept: string,
  read: (response: Response) => Promise<T>,
  conditional?: Validators,
): Promise<RequestResult<T>> {
  // `www.` and the bare host are one server, so they share one gate and one
  // back-off penalty. Keying them separately would let a retry under the other
  // spelling slip past the crawl delay the first spelling is serving.
  const host = new URL(url).hostname.replace(/^www\./, '');
  const robots = await robotsFor(url);
  const delay = Math.max(
    sourceDelayMs ?? env.crawlDefaultDelayMs,
    robots.crawlDelayMs ?? 0,
  );

  const headers: Record<string, string> = {
    'user-agent': env.userAgent,
    accept,
    'accept-language': 'en-US,en;q=0.9',
  };
  if (conditional?.etag) headers['if-none-match'] = conditional.etag;
  if (conditional?.lastModified) headers['if-modified-since'] = conditional.lastModified;

  return withHostTurn(host, delay, async () => {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(env.crawlTimeoutMs),
    });

    noteRetryAfter(host, response);

    const contentType = response.headers.get('content-type') ?? '';
    const finalUrl = response.url || url;
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    // 304 is a success: it means the copy we already hold is current. There is
    // no body to read, and reading one would block on a stream that never ends.
    if (response.status === 304) {
      return { status: 304, value: null, contentType, finalUrl, etag, lastModified };
    }

    if (!response.ok) {
      log.warn(`${response.status} ${url}`);
      return { status: response.status, value: null, contentType, finalUrl, etag, lastModified };
    }

    return {
      status: response.status,
      value: await read(response),
      contentType,
      finalUrl,
      etag,
      lastModified,
    };
  });
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
  // `response.text()` honours the charset the response declares, which is why
  // text fetches are not routed through `fetchBytes` and decoded as UTF-8.
  const { status, value, contentType, finalUrl } = await request(
    url,
    sourceDelayMs,
    accept,
    (response) => response.text(),
  );
  return { status, body: value, contentType, finalUrl };
}

/**
 * Fetch raw bytes. Only sitemaps need this: a `.xml.gz` arrives as compressed
 * bytes that no text decoding can recover, so the caller has to see them
 * undecoded to gunzip them.
 */
export async function fetchBytes(
  url: string,
  sourceDelayMs?: number,
  accept = 'application/xml,text/xml,application/gzip,text/plain',
): Promise<BytesFetchResult> {
  const { status, value, contentType, finalUrl } = await request(
    url,
    sourceDelayMs,
    accept,
    async (response) => new Uint8Array(await response.arrayBuffer()),
  );
  return { status, bytes: value, contentType, finalUrl };
}

export async function fetchPage(
  url: string,
  sourceDelayMs?: number,
  conditional?: Validators,
): Promise<FetchResult> {
  const result = await request(
    url,
    sourceDelayMs,
    'text/html,application/xhtml+xml',
    (response) => response.text(),
    conditional,
  );
  const isHtml = result.value !== null && result.contentType.includes('html');
  return {
    status: result.status,
    html: isHtml ? result.value : null,
    finalUrl: result.finalUrl,
    etag: result.etag,
    lastModified: result.lastModified,
    notModified: result.status === 304,
  };
}

/** Retry wrapper with exponential backoff; only retries transient failures. */
export async function fetchWithRetry(
  url: string,
  sourceDelayMs?: number,
  attempts = 3,
  conditional?: Validators,
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fetchPage(url, sourceDelayMs, conditional);
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
