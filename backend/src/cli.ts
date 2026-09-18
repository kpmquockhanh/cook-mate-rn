import { readFile } from 'node:fs/promises';
import { clearTestUsers, seedTestUsers } from './auth/seed.js';
import { reportUnmatched } from './canonical/match.js';
import { seedCanonical } from './canonical/seed.js';
import { discover } from './crawl/discover.js';
import { extractProseAll } from './crawl/prose-run.js';
import { crawl, enqueue, extractionReport, robotsAudit } from './crawl/run.js';
import { listSources, setSourcePolicy } from './crawl/sources.js';
import { close } from './db.js';
import { withJobLock } from './jobs/locks.js';
import { enrichAll, enrichEscalate } from './enrich/run.js';
import { gateAll } from './gate/run.js';
import { mirrorImages } from './images/run.js';
import { logger } from './log.js';
import { migrate } from './migrate.js';
import { parseAll } from './parse/run.js';
import { preflight, printPreflight, publishAll } from './publish/run.js';
import { ensureImageBucket, publicBaseUrl } from './storage/images.js';
import { ensureBucket, describeStore } from './storage/pages.js';
import { backfillRawPages } from './storage/rawPages.js';
import { printRunLog, printRuns, type RunKind } from './jobs/runs.js';
import { startConsole } from './ui/server.js';

const log = logger('cli');

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function text(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) return undefined;
  return args[index + 1];
}

function option(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || index === args.length - 1) return fallback;
  const value = Number.parseInt(args[index + 1]!, 10);
  return Number.isFinite(value) ? value : fallback;
}

const USAGE = `
CookMate recipe pipeline

  setup                        Fresh database: migrate + seed, in order
  migrate                      Apply SQL migrations
  seed-canonical               Load/refresh the canonical ingredient dictionary
  seed-auth [--clear]          Create/refresh the test auth users (dev only)
  ui                           Pipeline console: run every stage from a browser
  enqueue <url|@file> ...      Queue URLs (@file reads one URL per line)
  discover <url>               Explore a site and queue the recipe URLs it finds
          [--mode auto|sitemap|links]  [--max-pages N] [--depth N]
          [--max-results N] [--verify] [--dry-run] [--subdomains]
          [--refetch]          Re-fetch pages already stored (default: reuse them)
          [--include <regex>] [--exclude <regex>]
  sources                      Per-domain crawl/licence policy
    sources set <domain>       --allow-images / --no-allow-images
                               --license <text> --name <text>
                               --delay <ms> --enable / --disable
                               --recrawl-days <n> / --no-recrawl
  crawl   [--limit N]          Stage 0: fetch + extract into raw_pages
          [--report]           Show which domains defeat tiers A and B
          [--robots-check]     Re-check queued URLs against robots.txt; reports only
  extract [--limit N]          Tier D: read recipes off pages tiers A/B/C missed (LLM)
          [--dry-run]          Show what it would extract, write nothing
  images  [--limit N] [--force] [--check]
                               Mirror recipe photos into our own storage bucket
  parse   [--limit N] [--force]  Stage 1: raw_pages -> staging (deterministic)
  enrich  [--limit N]          Stage 2: durations, step<->ingredient links (LLM)
          [--include-published]  also re-enrich live rows (after an ENRICHMENT_VERSION bump)
          [--escalate]         Re-run the review queue on the stronger model
  gate    [--limit N]          Stage 3: score, dedupe, route to review
  publish [--limit N]          Stage 4: write into the app tables
          [--check]            Introspect the schema without writing anything
          [--republish]        Also rewrite rows already published
  storage check                Verify page storage is reachable; create the bucket
  storage backfill [--batch N] Move raw_pages.html into object storage
  review                       Alias for \`ui\`
  runs    [--kind k] [--limit N] Per-run counters, oldest last, for comparison
          [--log ID]           Print the log that run stored, oldest first
  unmatched [--limit N]        Ingredients the dictionary is missing
  pipeline [--limit N]         crawl -> extract -> parse -> enrich -> gate (stops before publish)
`;

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const limit = option(args, 'limit', 50);

  switch (command) {
    // One command to bring an empty database up to a publishable state. The
    // order matters: the canonical dictionary needs the tables that `migrate`
    // creates, and `publish` needs both.
    case 'setup':
      await migrate();
      await seedCanonical();
      // Crawling writes its first page to object storage, so the bucket being
      // absent should surface here and not on the first fetch. A project
      // without storage credentials yet is a warning, not a failed setup.
      try {
        log.info(await ensureBucket());
      } catch (error) {
        log.warn(`page storage not ready: ${String(error)}`);
      }
      log.info('setup complete - run `npm run publish -- --check` to verify the app schema');
      break;

    case 'migrate':
      await migrate();
      break;

    case 'seed-canonical':
      await seedCanonical();
      break;

    // Deliberately not part of `setup`: these are real, signed-in-able accounts
    // and they have no business existing in a production project.
    case 'seed-auth':
      if (flag(args, 'clear')) await clearTestUsers();
      else await seedTestUsers();
      break;

    case 'enqueue': {
      const inputs = args.filter((a) => !a.startsWith('--'));
      const urls: string[] = [];
      for (const input of inputs) {
        if (input.startsWith('@')) {
          const contents = await readFile(input.slice(1), 'utf8');
          urls.push(...contents.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
        } else {
          urls.push(input);
        }
      }
      if (urls.length === 0) throw new Error('enqueue needs at least one URL or @file');
      await enqueue(urls);
      break;
    }

    // One seed URL in, many recipe URLs out. The console's Discover tab calls
    // the same function; this is here so a discovery run can be scripted.
    case 'discover': {
      const [seed] = args.filter((a) => !a.startsWith('--'));
      if (!seed) throw new Error('discover needs a url, e.g. `npm run discover -- https://example.com`');

      const mode = text(args, 'mode') ?? 'auto';
      if (mode !== 'auto' && mode !== 'sitemap' && mode !== 'links') {
        throw new Error(`--mode must be auto, sitemap or links (got "${mode}")`);
      }

      const result = await withJobLock('discover', () => discover(seed, {
        mode,
        maxPages: option(args, 'max-pages', 40),
        maxDepth: option(args, 'depth', 2),
        maxResults: option(args, 'max-results', 200),
        verify: flag(args, 'verify'),
        dryRun: flag(args, 'dry-run'),
        includeSubdomains: flag(args, 'subdomains'),
        refetch: flag(args, 'refetch'),
        include: text(args, 'include'),
        exclude: text(args, 'exclude'),
      }));

      if (flag(args, 'dry-run')) {
        for (const candidate of result.candidates) {
          console.log(`${candidate.verified ? 'recipe   ' : 'candidate'}  ${candidate.url}`);
        }
        log.info(`dry run - nothing written. ${result.candidates.length} candidate(s).`);
      }
      break;
    }

    // Images are the reason this exists: crawl creates every source with
    // allow_image_use = false, and publish honours that, so a crawl looks like
    // it "came back without images" until someone records the licence here.
    case 'sources': {
      const [sub, target] = args.filter((a) => !a.startsWith('--'));
      if (!sub || sub === 'list') {
        await listSources();
        break;
      }
      if (sub !== 'set' || !target) throw new Error('usage: sources set <domain> [flags]');

      const allowImages = flag(args, 'allow-images')
        ? true
        : flag(args, 'no-allow-images')
          ? false
          : undefined;
      const enabled = flag(args, 'enable') ? true : flag(args, 'disable') ? false : undefined;
      const delay = args.includes('--delay') ? option(args, 'delay', 2000) : undefined;
      // Days in, hours stored: nobody schedules a recipe site in hours.
      const recrawl = flag(args, 'no-recrawl')
        ? null
        : args.includes('--recrawl-days')
          ? option(args, 'recrawl-days', 30) * 24
          : undefined;

      await setSourcePolicy(target, {
        name: text(args, 'name'),
        license: text(args, 'license'),
        allowImageUse: allowImages,
        crawlDelayMs: delay,
        recrawlIntervalHours: recrawl,
        enabled,
      });
      break;
    }

    // Storage for crawled HTML. `check` is the one to run after `setup`;
    // `backfill` is only needed once, on a database that predates 0006.
    case 'storage': {
      const [sub = 'check'] = args.filter((a) => !a.startsWith('--'));
      if (sub === 'check') {
        log.info(describeStore());
        log.info(await ensureBucket());
      } else if (sub === 'backfill') {
        await backfillRawPages(option(args, 'batch', 200));
      } else {
        throw new Error('usage: storage check | storage backfill [--batch N]');
      }
      break;
    }

    case 'crawl':
      if (flag(args, 'report')) await extractionReport();
      else if (flag(args, 'robots-check')) await robotsAudit(option(args, 'limit', 500));
      else await withJobLock('crawl', () => crawl(limit));
      break;

    // Tier D. Reads stored pages only - it never touches the network, so it is
    // safe to re-run over the whole backlog after changing the prompt.
    case 'extract':
      await withJobLock('extract', () => extractProseAll(limit, { dryRun: flag(args, 'dry-run') }));
      break;

    // Copies each recipe's photos into our own public bucket. Runs after parse
    // (which finds the URLs) and before publish (which writes the stored paths
    // to the app's tables). Only sources with allow_image_use are touched.
    case 'images':
      if (flag(args, 'check')) {
        log.info(await ensureImageBucket());
        log.info(`app must point EXPO_PUBLIC_STORAGE_URL at ${publicBaseUrl()}`);
      } else {
        await withJobLock('images', () => mirrorImages(limit, { force: flag(args, 'force') }));
      }
      break;

    case 'parse':
      await withJobLock('parse', () => parseAll(limit, flag(args, 'force')));
      break;

    case 'enrich':
      if (flag(args, 'escalate')) await withJobLock('enrich', () => enrichEscalate(limit));
      else
        await withJobLock('enrich', () =>
          // --include-published re-enriches rows that are already live, for
          // after an ENRICHMENT_VERSION bump. Follow it with
          // `publish --republish` or nothing changes in the app.
          enrichAll(limit, { includePublished: flag(args, 'include-published') }),
        );
      break;

    case 'gate':
      await withJobLock('gate', () => gateAll(limit));
      break;

    case 'publish':
      if (flag(args, 'check')) printPreflight(await preflight());
      else await withJobLock('publish', () => publishAll(limit, flag(args, 'republish')));
      break;

    // Same server either way: `review` is what this command used to be called,
    // and the review queue is one of the console's tabs.
    case 'ui':
    case 'console':
    case 'review':
      await startConsole();
      return; // keep the process alive for the server

    // Counters, not a log: the question is whether this run went worse than
    // the last one, which needs runs side by side.
    case 'runs': {
      // A run id asks for that run's lines instead: the counters say a run
      // went worse, the log says which URLs did it.
      const runId = option(args, 'log', 0);
      if (runId > 0) {
        await printRunLog(runId);
        break;
      }
      const kind = text(args, 'kind');
      if (kind && !['crawl', 'discover', 'extract'].includes(kind)) {
        throw new Error(`--kind must be crawl, discover or extract (got "${kind}")`);
      }
      await printRuns(kind as RunKind | undefined, option(args, 'limit', 10));
      break;
    }

    case 'unmatched':
      await reportUnmatched(option(args, 'limit', 50));
      break;

    case 'pipeline':
      // One lock for the whole sequence rather than one per stage: the point
      // of a pipeline is that the stages hand work to each other, so another
      // process stepping into the middle of it is exactly what to prevent.
      await withJobLock('pipeline', async () => {
        await crawl(limit);
        await extractProseAll(limit);
        await parseAll(limit);
        await mirrorImages(limit);
        await enrichAll(limit);
        await gateAll(limit);
      });
      log.info('pipeline done - run `npm run ui` to triage, then `npm run publish`');
      break;

    default:
      console.log(USAGE);
  }

  await close();
}

main().catch(async (error) => {
  log.error(error instanceof Error ? error.message : String(error));
  await close();
  process.exit(1);
});
