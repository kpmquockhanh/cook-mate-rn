#!/usr/bin/env node
/**
 * One command to get a fresh clone runnable.
 *
 * The repo is three npm packages (the Expo app at the root, backend/, agent/)
 * with three separate .env files, so "install and fill in the env" is six
 * manual steps nobody remembers in the right order. This does them, then hands
 * off to check-env.mjs and prints exactly which values are still placeholders.
 *
 * Safe to re-run: an existing .env is never touched.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  { name: 'app (root)', dir: '.' },
  { name: 'backend', dir: 'backend' },
  { name: 'agent', dir: 'agent' },
];

/** Values that mean "the template's placeholder is still here". */
const PLACEHOLDER = /^$|your-|your_|PROJECT\.|:PASSWORD@|change-me|\.\.\.$|example\.com/;

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

console.log('Installing dependencies for three packages...\n');
for (const pkg of PACKAGES) {
  console.log(`--- ${pkg.name} ---`);
  run('npm', ['install', '--no-audit', '--no-fund'], path.join(root, pkg.dir));
  console.log('');
}

console.log('Checking .env files...\n');
const needsValues = [];

for (const pkg of PACKAGES) {
  const envPath = path.join(root, pkg.dir, '.env');
  const examplePath = path.join(root, pkg.dir, '.env.example');
  const rel = path.relative(root, envPath) || '.env';

  if (!existsSync(examplePath)) {
    console.log(`  --  ${pkg.name}: no .env.example, skipping`);
    continue;
  }
  if (existsSync(envPath)) {
    console.log(`  ok  ${rel} already exists, left alone`);
  } else {
    copyFileSync(examplePath, envPath);
    console.log(`  +   ${rel} created from .env.example`);
  }

  // Report placeholders whether the file was just created or not - a .env that
  // predates a new required variable has the same problem.
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && PLACEHOLDER.test(match[2])) needsValues.push(`${rel}: ${match[1]}`);
  }
}

console.log('');
try {
  run('node', [path.join(root, 'scripts', 'check-env.mjs')], root);
} catch {
  // check-env has already printed the detail; setup still has more to say.
}

if (needsValues.length > 0) {
  console.log('\nStill needs a real value before things will run:');
  for (const item of needsValues) console.log(`  - ${item}`);
}

console.log(`
Next:
  npm start                 # Expo dev server for the app
  docker compose up --build # backend API (8787), console (5174), voice agent

The backend also needs its schema before first use:
  cd backend && npm run migrate
`);
