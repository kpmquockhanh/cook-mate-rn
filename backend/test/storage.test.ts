import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

// Set before the store is imported. The filesystem driver keeps most of this
// suite free of an object store; the s3 driver is exercised through a fake
// client at the end.
let dir: string;
let store: typeof import('../src/storage/pages.js');
let s3: typeof import('../src/storage/s3.js');
let env: typeof import('../src/env.js').env;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cookmate-pages-'));
  process.env.RAW_PAGE_STORE = 'file';
  process.env.RAW_PAGE_DIR = dir;
  store = await import('../src/storage/pages.js');
  s3 = await import('../src/storage/s3.js');
  env = (await import('../src/env.js')).env;
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

/** Swap to the s3 driver backed by an in-memory fake; returns the fake's objects. */
function useFakeS3(): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  s3.setS3ClientForTests({
    async send(command: unknown) {
      const { Bucket, Key, Body } = (command as { input: { Bucket: string; Key: string; Body?: Uint8Array } })
        .input;
      if (command instanceof PutObjectCommand) {
        objects.set(`${Bucket}/${Key}`, Body!);
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const bytes = objects.get(`${Bucket}/${Key}`);
        if (!bytes) {
          throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        }
        return { Body: { transformToByteArray: async () => bytes } };
      }
      throw new Error(`unexpected command ${String(command)}`);
    },
  });
  process.env.RAW_PAGE_STORE = '';
  store.resetPageStore();
  return objects;
}

function useFileStore(): void {
  s3.setS3ClientForTests(null);
  process.env.RAW_PAGE_STORE = 'file';
  store.resetPageStore();
}

test('with RAW_PAGE_STORE unset, pages go to the raw-page bucket, gzipped', async () => {
  const objects = useFakeS3();
  try {
    const html = '<html><body>bún chả</body></html>';
    const objectPath = await store.writePage('d'.repeat(64), html);

    const stored = objects.get(`${env.rawPageBucket}/${objectPath}`);
    assert.ok(stored, 'object written to the raw-page bucket');
    assert.equal(gunzipSync(stored).toString('utf8'), html);
    assert.equal(await store.readPage(objectPath), html);
    assert.equal(await store.readPage('ff/missing.html.gz'), null);
  } finally {
    useFileStore();
  }
});

test('a leftover RAW_PAGE_STORE value from before MinIO is rejected, not guessed at', () => {
  process.env.RAW_PAGE_STORE = 'supabase';
  store.resetPageStore();
  try {
    assert.throws(() => store.describeStore(), /RAW_PAGE_STORE="supabase".*s3.*file/);
  } finally {
    useFileStore();
  }
});
