import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { gunzipSync } from 'node:zlib';

// `env` reads these once, at module load, so they are set before the store is
// imported. The filesystem driver is what keeps this suite free of a Supabase
// project - the deployed crawler uses Supabase Storage.
let dir: string;
let store: typeof import('../src/storage/pages.js');

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cookmate-pages-'));
  process.env.RAW_PAGE_STORE = 'file';
  process.env.RAW_PAGE_DIR = dir;
  store = await import('../src/storage/pages.js');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HASH = 'a'.repeat(64);

test('a page round-trips through the store', async () => {
  const html = '<html><body><h1>Phở bò</h1></body></html>';
  const objectPath = await store.writePage(HASH, html);

  assert.equal(await store.readPage(objectPath), html);
});

test('the object key is derived from the content hash, not the URL', async () => {
  // Content-addressed: the same HTML reached by two URLs is one object, and
  // re-storing an unchanged page overwrites itself instead of accumulating.
  assert.equal(store.pathForContent(HASH), `aa/${HASH}.html.gz`);

  const first = await store.writePage(HASH, '<html>same</html>');
  const second = await store.writePage(HASH, '<html>same</html>');
  assert.equal(first, second);
});

test('stored bytes are gzipped, not plain HTML', async () => {
  const html = '<html>'.concat('<p>compress me</p>'.repeat(200), '</html>');
  const objectPath = await store.writePage('b'.repeat(64), html);

  const raw = await readFile(path.join(dir, objectPath));
  assert.equal(raw[0], 0x1f);
  assert.equal(raw[1], 0x8b);
  assert.ok(raw.length < Buffer.byteLength(html), 'gzipped copy should be smaller');
  assert.equal(gunzipSync(raw).toString('utf8'), html);
});

test('non-UTF8-safe content survives the round trip', async () => {
  // Page text is stored as UTF-8 bytes; anything that decoded correctly on the
  // way in has to come back byte-identical.
  const html = '<html><body>café — 日本語 — 🍜</body></html>';
  const objectPath = await store.writePage('c'.repeat(64), html);
  assert.equal(await store.readPage(objectPath), html);
});

test('a missing object reads as null rather than throwing', async () => {
  assert.equal(await store.readPage('ff/does-not-exist.html.gz'), null);
});
