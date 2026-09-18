import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, type DiscoverOptions } from '../crawl/discover.js';
import { extractProseAll } from '../crawl/prose-run.js';
import { crawl, enqueue } from '../crawl/run.js';
import { setSourcePolicy } from '../crawl/sources.js';
import { query } from '../db.js';
import { enrichAll } from '../enrich/run.js';
import { env } from '../env.js';
import { gateAll } from '../gate/run.js';
import {
  cancelJob,
  getJob,
  type JobKind,
  listJobs,
  runningJob,
  startJob,
} from '../jobs/runner.js';
import { getRun, recentRuns, runLog, type RunKind } from '../jobs/runs.js';
import { logger } from '../log.js';
import { countPendingImages, mirrorImages } from '../images/run.js';
import { countPendingParse, parseAll } from '../parse/run.js';
import { preflight } from '../publish/preflight.js';
import { countPendingPublish, publishAll } from '../publish/run.js';

const log = logger('console');
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function bad(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------------------
// Auth
//
// The console has no per-user accounts - it is one shared operator tool - so
// HTTP Basic Auth against a single configured credential is the right amount
// of mechanism. Boot-time check so a deploy missing the credentials fails
// immediately instead of quietly serving the console to anyone who finds it.
// ---------------------------------------------------------------------------

function assertConsoleAuthConfigured(): void {
  if (!env.reviewUsername || !env.reviewPassword) {
    throw new Error(
      'Console auth is not configured: set REVIEW_USERNAME and REVIEW_PASSWORD. ' +
        'See backend/.env.example.',
    );
  }
}

/** Constant-time string compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a same-cost comparison so a wrong-length guess takes the same
    // time as a wrong-content one of the right length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function authenticated(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;

  return (
    safeEqual(decoded.slice(0, sep), env.reviewUsername!) &&
    safeEqual(decoded.slice(sep + 1), env.reviewPassword!)
  );
}

function requireAuth(res: http.ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Basic realm="cookmate-console"',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) reject(bad('body too large', 413));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function json<T>(req: http.IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (!body.trim()) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw bad('request body is not valid JSON');
  }
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Accept a JSON array, or a whole textarea of pasted URLs separated by
 * newlines, spaces or commas. Anything that is not an http(s) URL is dropped
 * and counted rather than passed on: a paste from a spreadsheet or a numbered
 * list carries stray tokens, and reporting them as "already queued" would be a
 * lie about what happened.
 */
function urlList(input: unknown): { urls: string[]; rejected: number } {
  const text = Array.isArray(input)
    ? input.map(String).join('\n')
    : typeof input === 'string'
      ? input
      : '';

  const tokens = text
    .split(/\r?\n/)
    .flatMap((line) => (line.trim().startsWith('#') ? [] : line.split(/[\s,]+/)))
    .map((token) => token.trim())
    .filter(Boolean);

  const urls = new Set<string>();
  for (const token of tokens) {
    try {
      const url = new URL(token);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(token);
    } catch {
      /* counted below */
    }
  }
  return { urls: [...urls], rejected: tokens.length - urls.size };
}

// ---------------------------------------------------------------------------
// Stages
//
// Each entry is the same call the matching CLI command makes. The console is a
// second front end onto the pipeline, never a second implementation of it.
// ---------------------------------------------------------------------------

type StageRunner = (
  limit: number,
  flags: Record<string, boolean>,
) => Promise<unknown>;

const STAGES: Record<Exclude<JobKind, 'discover' | 'pipeline'>, StageRunner> = {
  crawl: (limit) => crawl(limit),
  extract: (limit, flags) => extractProseAll(limit, { dryRun: flags.dryRun ?? false }),
  parse: (limit, flags) => parseAll(limit, flags.force ?? false),
  images: (limit, flags) => mirrorImages(limit, { force: flags.force ?? false }),
  enrich: (limit, flags) => enrichAll(limit, { escalate: flags.escalate ?? false }),
  gate: (limit) => gateAll(limit),
  publish: (limit, flags) => publishAll(limit, flags.republish ?? false),
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(
  url: URL,
  req: http.IncomingMessage,
): Promise<unknown> {
  const route = `${req.method} ${url.pathname}`;

  // --- overview ------------------------------------------------------------
  if (route === 'GET /api/overview') {
    const [staging, queue, sources, unmatched, extractable, parsable, mirrorable, publishable] =
      await Promise.all([
      query(
        `select status, count(*)::int as count, round(avg(quality_score))::int as avg_score
           from crawler.recipe_staging group by status`,
      ),
      query(
        `select status, count(*)::int as count from crawler.crawl_queue group by status`,
      ),
      query(
        `select count(*)::int as total,
                count(*) filter (where allow_image_use)::int as image_ok,
                count(*) filter (where not enabled)::int as disabled
           from crawler.sources`,
      ),
      query(
        `select count(*)::int as count from crawler.unmatched_ingredients where resolved_to is null`,
      ),
      // Pages nothing could read yet, and the current prompt version has not
      // looked at: the backlog the Extract stage would work through.
      query(
        `select count(*)::int as count from crawler.raw_pages
          where extractor = 'none'
            and (extraction_version is null or extraction_version < $1)`,
        [env.extractionVersion],
      ),
      // The same set the Parse stage would work through - not `crawl_queue`
      // rows in 'done', which is a permanent record that a URL was fetched and
      // so never drains.
      countPendingParse(),
      countPendingImages(),
      countPendingPublish(),
    ]);
    return {
      staging,
      queue,
      sources: sources[0] ?? { total: 0, image_ok: 0, disabled: 0 },
      unmatched: unmatched[0]?.count ?? 0,
      extractable: extractable[0]?.count ?? 0,
      parsable,
      mirrorable,
      publishable,
      running: Object.fromEntries(
        ([
          'discover', 'crawl', 'extract', 'parse', 'images', 'enrich', 'gate', 'publish',
          'pipeline',
        ] as JobKind[]).map(
          (kind) => [kind, runningJob(kind)?.id ?? null],
        ),
      ),
    };
  }

  if (route === 'GET /api/preflight') return preflight();

  // --- crawl queue ---------------------------------------------------------
  if (route === 'GET /api/queue') {
    const status = url.searchParams.get('status');
    const search = url.searchParams.get('q');
    return query(
      `select q.id, q.url, q.status, q.attempts, q.last_error, q.priority,
              q.enqueued_at, q.finished_at, s.domain
         from crawler.crawl_queue q
         left join crawler.sources s on s.id = q.source_id
        where ($1::text is null or q.status = $1)
          and ($2::text is null or q.url ilike '%' || $2 || '%')
        order by q.id desc
        limit $3 offset $4`,
      [
        status && status !== 'all' ? status : null,
        search || null,
        Math.min(intParam(url, 'limit', 100), 500),
        intParam(url, 'offset', 0),
      ],
    );
  }

  if (route === 'POST /api/queue/retry') {
    const body = await json<{ ids?: number[]; status?: string }>(req);
    // Reset attempts too: a URL that failed three times deserves a clean slate
    // when a human deliberately asks for it again.
    if (body.ids?.length) {
      const rows = await query(
        `update crawler.crawl_queue
            set status = 'pending', attempts = 0, last_error = null, finished_at = null
          where id = any($1::bigint[]) returning id`,
        [body.ids],
      );
      return { requeued: rows.length };
    }
    if (body.status) {
      const rows = await query(
        `update crawler.crawl_queue
            set status = 'pending', attempts = 0, last_error = null, finished_at = null
          where status = $1 returning id`,
        [body.status],
      );
      return { requeued: rows.length };
    }
    throw bad('retry needs ids or a status');
  }

  if (route === 'POST /api/queue/delete') {
    const body = await json<{ ids?: number[] }>(req);
    if (!body.ids?.length) throw bad('delete needs ids');
    const rows = await query(
      `delete from crawler.crawl_queue where id = any($1::bigint[]) returning id`,
      [body.ids],
    );
    return { deleted: rows.length };
  }

  // --- bulk enqueue --------------------------------------------------------
  if (route === 'POST /api/enqueue') {
    const body = await json<{ urls?: unknown; priority?: number }>(req);
    const { urls, rejected } = urlList(body.urls);
    if (urls.length === 0) throw bad('no usable urls in that input');
    const added = await enqueue(urls, body.priority ?? 100);
    return { submitted: urls.length, added, alreadyQueued: urls.length - added, rejected };
  }

  // --- discovery -----------------------------------------------------------
  if (route === 'POST /api/discover') {
    const body = await json<DiscoverOptions & { url?: string }>(req);
    if (!body.url) throw bad('discover needs a url');
    let seed: string;
    try {
      seed = new URL(body.url).toString();
    } catch {
      throw bad(`"${body.url}" is not a url`);
    }
    const options: DiscoverOptions = {
      mode: body.mode ?? 'auto',
      maxPages: Math.min(body.maxPages ?? 40, 500),
      maxDepth: Math.min(body.maxDepth ?? 2, 5),
      maxResults: Math.min(body.maxResults ?? 200, 2000),
      verify: body.verify ?? false,
      dryRun: body.dryRun ?? false,
      includeSubdomains: body.includeSubdomains ?? false,
      refetch: body.refetch ?? false,
      include: body.include,
      exclude: body.exclude,
    };
    return startJob('discover', seed, options as Record<string, unknown>, (ctx) =>
      discover(seed, { ...options, signal: ctx.signal }),
    );
  }

  // --- stages --------------------------------------------------------------
  if (route === 'POST /api/run') {
    const body = await json<{
      stage?: string;
      limit?: number;
      flags?: Record<string, boolean>;
    }>(req);
    const limit = Math.max(1, Math.min(body.limit ?? 50, 5000));
    const flags = body.flags ?? {};

    if (body.stage === 'pipeline') {
      return startJob('pipeline', `crawl → gate · limit ${limit}`, { limit, flags }, async (ctx) => {
        const results: Record<string, unknown> = {};
        // Cancellation is cooperative and lands between stages: the individual
        // stages are bounded by `limit`, so the wait is short and bounded.
        for (const [name, run] of [
          ['crawl', STAGES.crawl],
          ['parse', STAGES.parse],
          ['images', STAGES.images],
          ['enrich', STAGES.enrich],
          ['gate', STAGES.gate],
        ] as const) {
          if (ctx.signal.aborted) {
            ctx.log.warn(`cancelled before ${name}`);
            break;
          }
          ctx.log.info(`--- ${name} ---`);
          results[name] = await run(limit, flags);
          ctx.progress({ [name]: results[name] });
        }
        return results;
      });
    }

    const stage = body.stage as keyof typeof STAGES;
    const run = STAGES[stage];
    if (!run) throw bad(`unknown stage "${body.stage}"`);
    // The console shows this next to the job's kind, so it must not repeat it.
    const on = Object.entries(flags)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    const label = [`limit ${limit}`, ...on].join(' · ');
    return startJob(stage, label, { limit, flags }, () => run(limit, flags));
  }

  // --- jobs ----------------------------------------------------------------
  if (route === 'GET /api/jobs') return listJobs();

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (jobMatch && req.method === 'GET') {
    const job = await getJob(jobMatch[1]!, intParam(url, 'since', 0));
    if (!job) throw bad('no such job', 404);
    return job;
  }

  const cancelMatch = /^\/api\/jobs\/([0-9a-f-]+)\/cancel$/i.exec(url.pathname);
  if (cancelMatch && req.method === 'POST') {
    return { cancelled: cancelJob(cancelMatch[1]!) };
  }

  // --- sources -------------------------------------------------------------
  if (route === 'GET /api/sources') {
    return query(
      `select s.id, s.domain, s.name, s.license, s.allow_image_use, s.crawl_delay_ms,
              s.recrawl_interval_hours, s.enabled,
              count(r.id)::int as pages,
              count(r.id) filter (where r.extractor = 'none')::int as extract_failures
         from crawler.sources s
         left join crawler.raw_pages r on r.source_id = s.id
        group by s.id
        order by s.domain`,
    );
  }

  if (route === 'POST /api/sources') {
    const body = await json<{
      domain?: string;
      name?: string;
      license?: string;
      allowImageUse?: boolean;
      crawlDelayMs?: number;
      recrawlIntervalHours?: number | null;
      enabled?: boolean;
    }>(req);
    if (!body.domain) throw bad('sources needs a domain');
    await setSourcePolicy(body.domain, body);
    return { ok: true };
  }

  // --- review queue --------------------------------------------------------
  if (route === 'GET /api/review') {
    const status = url.searchParams.get('status') ?? 'review';
    return query(
      `select id, title, source_url, image_url, servings, total_time_seconds,
              quality_score, quality_issues, status, enrichment_model,
              ingredients, steps, enriched
         from crawler.recipe_staging
        where status = $1
        order by quality_score desc nulls last, id
        limit 100`,
      [status],
    );
  }

  if (route === 'POST /api/decide') {
    const body = await json<{ id?: number; ids?: number[]; decision?: string }>(req);
    const { decision } = body;
    if (decision !== 'approved' && decision !== 'rejected') throw bad('bad decision');
    const ids = body.ids?.length ? body.ids : body.id !== undefined ? [body.id] : [];
    if (ids.length === 0) throw bad('decide needs an id');
    // edited_by_human pins the row: later pipeline runs will not overwrite it.
    const rows = await query(
      `update crawler.recipe_staging
          set status = $2, edited_by_human = true
        where id = any($1::bigint[]) returning id`,
      [ids, decision],
    );
    return { updated: rows.length };
  }

  // --- runs ---------------------------------------------------------------
  if (route === 'GET /api/runs') {
    const kind = url.searchParams.get('kind') ?? undefined;
    if (kind && !['crawl', 'discover', 'extract'].includes(kind)) {
      throw bad(`unknown run kind "${kind}"`);
    }
    return recentRuns(kind as RunKind | undefined, intParam(url, 'limit', 20));
  }

  // The stored log of one run, which outlives the job that produced it: this
  // is how a crawl that ran overnight is read the next morning.
  const runLogMatch = /^\/api\/runs\/(\d+)\/log$/.exec(url.pathname);
  if (runLogMatch && req.method === 'GET') {
    const id = Number(runLogMatch[1]);
    const run = await getRun(id);
    if (!run) throw bad(`no run #${id}`, 404);
    // The run comes back with its lines so a reader tailing a live run learns
    // it has finished from the same request that stops returning new lines.
    return {
      run,
      lines: await runLog(id, intParam(url, 'since', 0), Math.min(intParam(url, 'limit', 1000), 5000)),
    };
  }

  if (route === 'GET /api/unmatched') {
    return query(
      `select id, raw_name, normalized, occurrences, example_url
         from crawler.unmatched_ingredients
        where resolved_to is null
        order by occurrences desc limit 100`,
    );
  }

  throw bad('not found', 404);
}

// ---------------------------------------------------------------------------

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(publicDir, relative);
  // Never serve outside the bundled public directory, whatever the URL says.
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    // Unknown path: hand back the app shell so the UI owns its own routing.
    const shell = await readFile(path.resolve(publicDir, 'index.html'));
    res.writeHead(200, { 'content-type': MIME['.html']!, 'cache-control': 'no-store' });
    res.end(shell);
  }
}

/**
 * The operator console: one local page for the whole pipeline - discover,
 * enqueue, run each stage, watch it happen, triage what comes out.
 *
 * It binds to 127.0.0.1 by default and requires HTTP Basic Auth
 * (REVIEW_USERNAME/REVIEW_PASSWORD) on every request. It can start crawls and
 * spend model budget, so both matter: only set REVIEW_HOST to something other
 * than 127.0.0.1 (as the Docker image does) once the credentials are set.
 */
export async function startConsole(): Promise<void> {
  assertConsoleAuthConfigured();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${env.reviewPort}`);
    if (!authenticated(req)) {
      requireAuth(res);
      return;
    }
    try {
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic(url.pathname, res);
        return;
      }
      const payload = await handleApi(url, req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload ?? null));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) log.error(`${req.method} ${url.pathname}`, message);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  server.listen(env.reviewPort, env.reviewHost, () => {
    log.info(`pipeline console on http://${env.reviewHost}:${env.reviewPort}`);
  });
}
