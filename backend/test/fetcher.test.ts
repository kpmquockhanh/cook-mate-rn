import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test, { afterEach, beforeEach } from 'node:test';
import {
  fetchBytes,
  fetchPage,
  fetchText,
  parseRetryAfter,
  resetHostState,
} from '../src/crawl/fetcher.js';
import { resetRobotsCache } from '../src/crawl/robots.js';

interface Span {
  url: string;
  start: number;
  end: number;
}

const realFetch = globalThis.fetch;

/**
 * Stand in for the network, recording when each request started and finished so
 * a test can assert on overlap and spacing. robots.txt is answered 404 - the
 * reader treats that as permissive - and is excluded from the record, since it
 * does not go through the host gate.
 */
function stubNetwork(latencyMs: number): Span[] {
  const spans: Span[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.endsWith('/robots.txt')) {
      return new Response('not found', { status: 404 });
    }

    const span: Span = { url, start: Date.now(), end: 0 };
    spans.push(span);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    span.end = Date.now();

    return new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof globalThis.fetch;

  return spans;
}

beforeEach(() => {
  resetRobotsCache();
  resetHostState();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('requests to one host never overlap, even when slower than the delay', async () => {
  // The regression this guards: the gate used to open `delay` after a turn was
  // granted rather than after the response landed, so a response slower than
  // the delay let the next request start while it was still in flight.
  const latency = 120;
  const delay = 40;
  const spans = stubNetwork(latency);

  await Promise.all([
    fetchText('https://example.com/a', delay),
    fetchText('https://example.com/b', delay),
    fetchText('https://example.com/c', delay),
  ]);

  assert.equal(spans.length, 3);
  const ordered = [...spans].sort((a, b) => a.start - b.start);

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    assert.ok(
      current.start >= previous.end,
      `request ${i} started ${previous.end - current.start}ms before the previous one finished`,
    );
  }
});

test('consecutive requests to one host are spaced by the delay, measured from completion', async () => {
  const latency = 30;
  const delay = 80;
  const spans = stubNetwork(latency);

  await Promise.all([
    fetchText('https://spaced.example/a', delay),
    fetchText('https://spaced.example/b', delay),
  ]);

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const gap = ordered[1]!.start - ordered[0]!.end;

  // Timer granularity makes an exact equality flaky; the point is that the gap
  // is the delay and is not swallowed by the time the request itself took.
  assert.ok(gap >= delay - 10, `expected a gap of at least ${delay}ms, got ${gap}ms`);
});

test('different hosts are not serialized against each other', async () => {
  const latency = 60;
  const delay = 500;
  const spans = stubNetwork(latency);

  const started = Date.now();
  await Promise.all([
    fetchText('https://one.example/a', delay),
    fetchText('https://two.example/a', delay),
  ]);
  const elapsed = Date.now() - started;

  assert.equal(spans.length, 2);
  // Serialized, this would take at least `delay`. In parallel it is about one
  // request's latency.
  assert.ok(elapsed < delay, `hosts were serialized: took ${elapsed}ms`);
});

test('a failed request still opens the gate behind it', async () => {
  const spans: Span[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });

    spans.push({ url, start: Date.now(), end: Date.now() });
    if (url.endsWith('/boom')) throw new Error('connection reset');
    return new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof globalThis.fetch;

  const results = await Promise.allSettled([
    fetchText('https://failing.example/boom', 10),
    fetchText('https://failing.example/after', 10),
  ]);

  assert.equal(results[0]!.status, 'rejected');
  // Without the gate opening on failure, this one would hang forever behind it.
  assert.equal(results[1]!.status, 'fulfilled');
  assert.equal(spans.length, 2);
});

test('the effective delay is the larger of the source policy and robots Crawl-delay', async () => {
  const spans: Span[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nCrawl-delay: 0.2', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    spans.push({ url, start: Date.now(), end: Date.now() });
    return new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof globalThis.fetch;

  await Promise.all([
    // A source policy of 5ms must not override the site's stated 200ms.
    fetchText('https://polite.example/a', 5),
    fetchText('https://polite.example/b', 5),
  ]);

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  const gap = ordered[1]!.start - ordered[0]!.end;
  assert.ok(gap >= 190, `robots Crawl-delay was not honoured: gap was ${gap}ms`);
});

test('fetchBytes returns the body undecoded, through the same host gate', async () => {
  const payload = gzipSync(Buffer.from('<urlset/>', 'utf8'));
  const seen: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
    seen.push(url);
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'application/gzip' },
    });
  }) as typeof globalThis.fetch;

  const result = await fetchBytes('https://bytes.example/sitemap.xml.gz', 5);

  assert.equal(result.status, 200);
  assert.ok(result.bytes);
  // Compressed bytes arrive intact - the gzip magic number is still there,
  // which is what lets the caller decide to gunzip.
  assert.equal(result.bytes![0], 0x1f);
  assert.equal(result.bytes![1], 0x8b);
  assert.deepEqual(seen, ['https://bytes.example/sitemap.xml.gz']);
});

test('a non-ok response yields no bytes rather than an empty buffer', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
    return new Response('nope', { status: 404 });
  }) as typeof globalThis.fetch;

  const result = await fetchBytes('https://missing.example/sitemap.xml', 5);
  assert.equal(result.status, 404);
  assert.equal(result.bytes, null);
});

test('Retry-After is read as seconds or as an HTTP date', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');

  assert.equal(parseRetryAfter('120', now), 120_000);
  assert.equal(parseRetryAfter('  30  ', now), 30_000);
  assert.equal(parseRetryAfter('Fri, 18 Sep 2026 12:02:00 GMT', now), 120_000);

  // A date already past means "you may go now", not a negative wait.
  assert.equal(parseRetryAfter('Fri, 18 Sep 2026 11:00:00 GMT', now), 0);

  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('soon', now), null);
});

test('a 429 with Retry-After closes the host, not just that one request', async () => {
  const spans: Span[] = [];
  let first = true;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });

    spans.push({ url, start: Date.now(), end: Date.now() });
    if (first) {
      first = false;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    }
    return new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }) as typeof globalThis.fetch;

  const started = Date.now();
  await fetchText('https://busy.example/a', 5);
  // A different URL on the same host: it must still wait out the back-off the
  // server asked for, or the crawler keeps hammering a host that said stop.
  await fetchText('https://busy.example/b', 5);
  const elapsed = Date.now() - started;

  assert.equal(spans.length, 2);
  assert.ok(elapsed >= 900, `expected to wait out the 1s back-off, took ${elapsed}ms`);
});

test('a conditional request sends the validators it was given', async () => {
  const headers: Record<string, string>[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });

    headers.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(null, { status: 304 });
  }) as typeof globalThis.fetch;

  const result = await fetchPage('https://cond.example/recipe', 5, {
    etag: 'W/"abc123"',
    lastModified: 'Wed, 10 Sep 2026 10:00:00 GMT',
  });

  assert.equal(headers[0]!['if-none-match'], 'W/"abc123"');
  assert.equal(headers[0]!['if-modified-since'], 'Wed, 10 Sep 2026 10:00:00 GMT');

  // 304 is a success carrying no body: the copy already held is current.
  assert.equal(result.status, 304);
  assert.equal(result.notModified, true);
  assert.equal(result.html, null);
});

test('a 200 reports the validators to store for next time', async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/robots.txt')) return new Response('not found', { status: 404 });
    return new Response('<html></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html',
        etag: '"v2"',
        'last-modified': 'Thu, 11 Sep 2026 08:00:00 GMT',
      },
    });
  }) as typeof globalThis.fetch;

  const result = await fetchPage('https://fresh.example/recipe', 5);
  assert.equal(result.notModified, false);
  assert.equal(result.etag, '"v2"');
  assert.equal(result.lastModified, 'Thu, 11 Sep 2026 08:00:00 GMT');
});
