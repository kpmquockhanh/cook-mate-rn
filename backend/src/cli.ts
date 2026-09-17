import { readFile } from 'node:fs/promises';
import { clearTestUsers, seedTestUsers } from './auth/seed.js';
import { reportUnmatched } from './canonical/match.js';
import { seedCanonical } from './canonical/seed.js';
import { discover } from './crawl/discover.js';
import { crawl, enqueue, extractionReport } from './crawl/run.js';
import { listSources, setSourcePolicy } from './crawl/sources.js';
import { close } from './db.js';
import { enrichAll, enrichEscalate } from './enrich/run.js';
import { gateAll } from './gate/run.js';
import { logger } from './log.js';
import { migrate } from './migrate.js';
import { parseAll } from './parse/run.js';
import { preflight, printPreflight, publishAll } from './publish/run.js';
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
          [--include <regex>] [--exclude <regex>]
  sources                      Per-domain crawl/licence policy
    sources set <domain>       --allow-images / --no-allow-images
                               --license <text> --name <text>
                               --delay <ms> --enable / --disable
  crawl   [--limit N]          Stage 0: fetch + extract into raw_pages
          [--report]           Show which domains defeat tiers A and B
  parse   [--limit N] [--force]  Stage 1: raw_pages -> staging (deterministic)
  enrich  [--limit N]          Stage 2: durations, step<->ingredient links (LLM)
          [--escalate]         Re-run the review queue on the stronger model
  gate    [--limit N]          Stage 3: score, dedupe, route to review
  publish [--limit N]          Stage 4: write into the app tables
          [--check]            Introspect the schema without writing anything
          [--republish]        Also rewrite rows already published
  review                       Alias for \`ui\`
  unmatched [--limit N]        Ingredients the dictionary is missing
  pipeline [--limit N]         crawl -> parse -> enrich -> gate (stops before publish)
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

      const result = await discover(seed, {
        mode,
        maxPages: option(args, 'max-pages', 40),
        maxDepth: option(args, 'depth', 2),
        maxResults: option(args, 'max-results', 200),
        verify: flag(args, 'verify'),
        dryRun: flag(args, 'dry-run'),
        includeSubdomains: flag(args, 'subdomains'),
        include: text(args, 'include'),
        exclude: text(args, 'exclude'),
      });

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

      await setSourcePolicy(target, {
        name: text(args, 'name'),
        license: text(args, 'license'),
        allowImageUse: allowImages,
        crawlDelayMs: delay,
        enabled,
      });
      break;
    }

    case 'crawl':
      if (flag(args, 'report')) await extractionReport();
      else await crawl(limit);
      break;

    case 'parse':
      await parseAll(limit, flag(args, 'force'));
      break;

    case 'enrich':
      if (flag(args, 'escalate')) await enrichEscalate(limit);
      else await enrichAll(limit);
      break;

    case 'gate':
      await gateAll(limit);
      break;

    case 'publish':
      if (flag(args, 'check')) printPreflight(await preflight());
      else await publishAll(limit, flag(args, 'republish'));
      break;

    // Same server either way: `review` is what this command used to be called,
    // and the review queue is one of the console's tabs.
    case 'ui':
    case 'console':
    case 'review':
      await startConsole();
      return; // keep the process alive for the server

    case 'unmatched':
      await reportUnmatched(option(args, 'limit', 50));
      break;

    case 'pipeline':
      await crawl(limit);
      await parseAll(limit);
      await enrichAll(limit);
      await gateAll(limit);
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
