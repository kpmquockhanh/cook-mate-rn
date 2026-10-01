import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { isSupportedImageType, pathForImage, publicBaseUrl, storeImage } from '../src/storage/images.js';
import { setS3ClientForTests } from '../src/storage/s3.js';
import { normalizeImages } from '../src/crawl/images.js';

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('an object key is derived from the bytes, not the URL', () => {
  // Content-addressed: the same photo reached from two recipes is one object,
  // and re-running the mirror overwrites it with itself.
  assert.equal(pathForImage(BYTES, 'image/png'), pathForImage(BYTES, 'image/png'));
  assert.notEqual(pathForImage(BYTES, 'image/png'), pathForImage(new Uint8Array([1]), 'image/png'));
});

test('the key is two-character sharded and carries the real extension', () => {
  const path = pathForImage(BYTES, 'image/webp');
  assert.match(path, /^[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/);
  assert.equal(path.slice(0, 2), path.slice(3, 5));
});

test('a content type with parameters is still recognised', () => {
  assert.ok(isSupportedImageType('image/jpeg; charset=binary'));
  assert.ok(isSupportedImageType('IMAGE/JPEG'));
});

test('an HTML error page served as a 200 is not an image', () => {
  // The failure this guards: storing the bytes of an error page under an
  // image key puts a broken picture in the app and a lie in the database.
  assert.equal(isSupportedImageType('text/html'), false);
  assert.equal(isSupportedImageType('application/pdf'), false);
});

test('CDN resize variants of one photo mirror once', () => {
  const urls = [
    'https://cdn.example.com/hero.jpg',
    'https://cdn.example.com/hero.jpg?resize=500%2C500',
    'https://cdn.example.com/other.jpg',
  ];
  assert.deepEqual(normalizeImages(urls), [
    'https://cdn.example.com/hero.jpg',
    'https://cdn.example.com/other.jpg',
  ]);
});

afterEach(() => {
  setS3ClientForTests(null);
});

test('a stored image goes to the image bucket with its real type and a long cache lifetime', async () => {
  const sent: unknown[] = [];
  setS3ClientForTests({
    async send(command: unknown) {
      sent.push(command);
      return {};
    },
  });

  const objectPath = await storeImage(BYTES, 'IMAGE/PNG; charset=binary');

  assert.equal(objectPath, pathForImage(BYTES, 'image/png'));
  const command = sent[0];
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, env.recipeImageBucket);
  assert.equal(command.input.Key, objectPath);
  assert.equal(command.input.ContentType, 'image/png');
  assert.equal(command.input.CacheControl, 'public, max-age=31536000, immutable');
});

test('the public base URL uses S3_PUBLIC_URL, else S3_ENDPOINT, without doubled slashes', () => {
  const saved = { public: process.env.S3_PUBLIC_URL, endpoint: process.env.S3_ENDPOINT };
  try {
    process.env.S3_ENDPOINT = 'http://minio:9000/';
    process.env.S3_PUBLIC_URL = 'http://192.168.1.20:9000/';
    assert.equal(publicBaseUrl(), `http://192.168.1.20:9000/${env.recipeImageBucket}`);

    process.env.S3_PUBLIC_URL = '';
    assert.equal(publicBaseUrl(), `http://minio:9000/${env.recipeImageBucket}`);

    process.env.S3_ENDPOINT = '';
    assert.throws(() => publicBaseUrl(), /S3_PUBLIC_URL.*S3_ENDPOINT/);
  } finally {
    process.env.S3_PUBLIC_URL = saved.public ?? '';
    process.env.S3_ENDPOINT = saved.endpoint ?? '';
  }
});

test('mirroring counts a bad photo as a failure and keeps going', async () => {
  const { mirrorCandidates } = await import('../src/images/run.js');
  const urls = ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg'];
  const result = await mirrorCandidates(7, urls, async (url) => {
    if (url.endsWith('1.jpg')) throw new Error('ECONNRESET');
    return url.endsWith('2.jpg') ? null : 'ab/abc.jpg';
  });
  assert.deepEqual(result, { paths: ['ab/abc.jpg'], failed: 1 });
});

// Otherwise the row is stamped as mirrored with no photos and never retried.
test('a storage failure stops mirroring instead of counting as a bad photo', async () => {
  const { ImageStorageError, mirrorCandidates } = await import('../src/images/run.js');
  let calls = 0;
  await assert.rejects(
    mirrorCandidates(7, ['https://a/1.jpg', 'https://a/2.jpg'], async () => {
      calls++;
      throw new ImageStorageError('S3 PutObject recipe-images/ab/abc.jpg failed: ECONNREFUSED');
    }),
    ImageStorageError
  );
  assert.equal(calls, 1);
});
