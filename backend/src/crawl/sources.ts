import { query } from '../db.js';
import { logger } from '../log.js';
import { domainOf } from '../util.js';

const log = logger('sources');

interface SourceRow {
  id: number;
  domain: string;
  name: string;
  license: string | null;
  allow_image_use: boolean;
  crawl_delay_ms: number;
  recrawl_interval_hours: number | null;
  enabled: boolean;
}

export interface SourcePolicy {
  name?: string;
  license?: string;
  allowImageUse?: boolean;
  crawlDelayMs?: number;
  /** Null disables revisiting this source. */
  recrawlIntervalHours?: number | null;
  enabled?: boolean;
}

/**
 * `crawl` auto-creates a source row per domain with the safe defaults -
 * `allow_image_use = false` above all, because a recipe's ingredient list is
 * not copyrightable but its photography is. Nothing else in the pipeline ever
 * flips that bit, so without this command `publish` silently drops every
 * image it crawled. This is where an operator records the licence check they
 * actually did.
 */
export async function setSourcePolicy(target: string, policy: SourcePolicy): Promise<void> {
  // Accept either a bare domain or any URL from the site.
  const domain = target.includes('://') ? domainOf(target) : target.trim().toLowerCase().replace(/^www\./, '');

  const sets: string[] = [];
  const values: unknown[] = [domain];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (policy.name !== undefined) set('name', policy.name);
  if (policy.license !== undefined) set('license', policy.license);
  if (policy.allowImageUse !== undefined) set('allow_image_use', policy.allowImageUse);
  if (policy.crawlDelayMs !== undefined) set('crawl_delay_ms', policy.crawlDelayMs);
  if (policy.recrawlIntervalHours !== undefined) {
    set('recrawl_interval_hours', policy.recrawlIntervalHours);
  }
  if (policy.enabled !== undefined) set('enabled', policy.enabled);

  if (sets.length === 0) throw new Error('sources set needs at least one policy flag');

  const rows = await query<SourceRow>(
    `update crawler.sources set ${sets.join(', ')}
      where domain = $1
      returning id, domain, name, license, allow_image_use, crawl_delay_ms,
                recrawl_interval_hours, enabled`,
    values,
  );

  if (rows.length === 0) {
    throw new Error(
      `no source for domain "${domain}" - run \`npm run enqueue -- <url>\` first, or check \`npm run dev -- sources\``,
    );
  }

  const row = rows[0]!;
  log.info(
    `${row.domain}: images=${row.allow_image_use} license=${row.license ?? '-'} ` +
      `enabled=${row.enabled} revisit=${describeInterval(row.recrawl_interval_hours)}`,
  );
  if (policy.allowImageUse) {
    log.info('re-run `npm run publish -- --republish` to backfill images onto already-published recipes');
  }
}

/** Hours are how it is stored; days are how an operator thinks about it. */
function describeInterval(hours: number | null): string {
  if (hours === null) return 'never';
  if (hours % 24 === 0) return `${hours / 24}d`;
  return `${hours}h`;
}

export async function listSources(): Promise<void> {
  const rows = await query<SourceRow>(
    `select id, domain, name, license, allow_image_use, crawl_delay_ms,
            recrawl_interval_hours, enabled
       from crawler.sources order by domain`,
  );

  if (rows.length === 0) {
    log.info('no sources yet - enqueue a URL to create one');
    return;
  }

  for (const row of rows) {
    console.log(
      [
        String(row.id).padStart(3),
        row.domain.padEnd(32),
        `images=${String(row.allow_image_use).padEnd(5)}`,
        `enabled=${String(row.enabled).padEnd(5)}`,
        `delay=${row.crawl_delay_ms}ms`,
        `revisit=${describeInterval(row.recrawl_interval_hours).padEnd(7)}`,
        `license=${row.license ?? '-'}`,
      ].join('  '),
    );
  }
}
