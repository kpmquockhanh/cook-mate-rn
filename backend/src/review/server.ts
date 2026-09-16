import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';

const log = logger('review');
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A deliberately small local triage tool for the review queue. It is not part
 * of the app and never faces the internet - bind is localhost only.
 */
async function handleApi(url: URL, req: http.IncomingMessage): Promise<unknown> {
  if (url.pathname === '/api/queue') {
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

  if (url.pathname === '/api/stats') {
    return query(
      `select status, count(*)::int as count, round(avg(quality_score))::int as avg_score
         from crawler.recipe_staging group by status order by status`,
    );
  }

  if (url.pathname === '/api/unmatched') {
    return query(
      `select id, raw_name, normalized, occurrences, example_url
         from crawler.unmatched_ingredients
        where resolved_to is null
        order by occurrences desc limit 100`,
    );
  }

  if (url.pathname === '/api/decide' && req.method === 'POST') {
    const body = await readBody(req);
    const { id, decision } = JSON.parse(body) as { id: number; decision: 'approved' | 'rejected' };
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('bad decision');
    // edited_by_human pins the row: later pipeline runs will not overwrite it.
    await query(
      `update crawler.recipe_staging
          set status = $2, edited_by_human = true
        where id = $1`,
      [id, decision],
    );
    return { ok: true };
  }

  throw Object.assign(new Error('not found'), { status: 404 });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startReviewServer(): Promise<void> {
  const html = await readFile(path.resolve(here, 'ui.html'), 'utf8');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${env.reviewPort}`);
    try {
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      const payload = await handleApi(url, req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  server.listen(env.reviewPort, '127.0.0.1', () => {
    log.info(`review UI on http://localhost:${env.reviewPort}`);
  });
}
