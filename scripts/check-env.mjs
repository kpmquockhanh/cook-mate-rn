#!/usr/bin/env node
/**
 * Checks the three .env sets (app, backend, agent) against two things that
 * drift apart silently:
 *
 *   1. Code vs .env.example - a variable read somewhere in src but documented
 *      nowhere is invisible to everyone who did not add it. This is the check
 *      that matters in CI, and it runs without any .env file present.
 *   2. .env vs .env.example - your local file against the template, in both
 *      directions. Skipped entirely when there is no .env, so CI stays quiet.
 *
 * Errors (exit 1) are drift someone has to fix; warnings are informational,
 * because a documented variable can legitimately be optional.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  {
    name: 'app (root)',
    example: '.env.example',
    env: '.env',
    sources: ['app', 'components', 'hooks', 'lib', 'utils', 'plugins'],
    // Only EXPO_PUBLIC_* is an app env var. Anything else in these files is
    // Node's own (NODE_ENV) and is not something .env.example should carry.
    include: (name) => name.startsWith('EXPO_PUBLIC_'),
  },
  {
    name: 'backend',
    example: 'backend/.env.example',
    env: 'backend/.env',
    sources: ['backend/src'],
  },
  {
    name: 'agent',
    example: 'agent/.env.example',
    env: 'agent/.env',
    sources: ['agent/src'],
  },
];

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

/**
 * Keys declared in an env file. `active` is what is actually set; `all` also
 * counts `# KEY=...` lines, since a commented-out key with a comment above it
 * is how the examples document an optional variable.
 */
function envKeys(file) {
  const active = new Set();
  const all = new Set();
  if (!existsSync(file)) return { active, all, exists: false };

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const live = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (live) {
      active.add(live[1]);
      all.add(live[1]);
      continue;
    }
    const commented = /^\s*#\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (commented) all.add(commented[1]);
  }
  return { active, all, exists: true };
}

function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (CODE_EXTENSIONS.has(path.extname(entry))) out.push(full);
  }
  return out;
}

/**
 * Variable names a body of code reads. Covers the three shapes this repo uses:
 * `process.env.NAME`, `process.env['NAME']`, and the name-as-string-argument
 * form of backend/src/env.ts's required('NAME') / int('NAME', fallback).
 */
function codeKeys(dirs, include = () => true) {
  const found = new Set();
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /\b(?:required|int)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  ];

  for (const dir of dirs) {
    for (const file of sourceFiles(path.join(root, dir))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          if (include(match[1])) found.add(match[1]);
        }
      }
    }
  }
  return found;
}

const sorted = (set) => [...set].sort();
let errors = 0;
let warnings = 0;

for (const target of TARGETS) {
  const example = envKeys(path.join(root, target.example));
  const local = envKeys(path.join(root, target.env));
  const used = codeKeys(target.sources, target.include);

  const problems = [];

  if (!example.exists) {
    problems.push({ level: 'error', message: `${target.example} is missing` });
  }

  for (const name of sorted(used)) {
    if (!example.all.has(name)) {
      problems.push({
        level: 'error',
        message: `${name} is read in code but documented nowhere in ${target.example}`,
      });
    }
  }

  if (local.exists) {
    for (const name of sorted(local.all)) {
      if (!example.all.has(name)) {
        problems.push({
          level: 'error',
          message: `${name} is set in ${target.env} but documented nowhere in ${target.example}`,
        });
      }
    }
    for (const name of sorted(example.active)) {
      if (!local.all.has(name)) {
        problems.push({
          level: 'warn',
          message: `${name} is filled in in ${target.example} but absent from ${target.env}`,
        });
      }
    }
  }

  const label = local.exists ? target.name : `${target.name} (no ${target.env}, code check only)`;
  if (problems.length === 0) {
    console.log(`  ok  ${label}`);
    continue;
  }

  console.log(`      ${label}`);
  for (const { level, message } of problems) {
    if (level === 'error') errors++;
    else warnings++;
    console.log(`${level === 'error' ? ' err ' : 'warn '} ${message}`);
  }
}

console.log('');
if (errors > 0) {
  console.error(
    `env check failed: ${errors} error${errors === 1 ? '' : 's'}` +
      (warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''),
  );
  process.exit(1);
}
console.log(`env check passed${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}`);
