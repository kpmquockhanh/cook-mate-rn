import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareStorage } from '../src/storage/setup.js';

const notConfigured = () => {
  throw new Error('Object storage is not configured: set S3_ENDPOINT.');
};

test('both buckets ready logs both reports and warns nothing', async () => {
  assert.deepEqual(
    await prepareStorage({
      pages: async () => 'bucket "raw-pages" already exists',
      images: async () => 'bucket "recipe-images" already exists (public)',
    }),
    {
      info: ['bucket "raw-pages" already exists', 'bucket "recipe-images" already exists (public)'],
      warn: [],
    }
  );
});

test('the same failure for both buckets is one warning, not two', async () => {
  assert.deepEqual(await prepareStorage({ pages: notConfigured, images: notConfigured }), {
    info: [],
    warn: ['object storage not ready: Error: Object storage is not configured: set S3_ENDPOINT.'],
  });
});

test('different outcomes are reported per bucket', async () => {
  assert.deepEqual(
    await prepareStorage({
      pages: async () => 'local directory /tmp/raw-pages',
      images: notConfigured,
    }),
    {
      info: ['local directory /tmp/raw-pages'],
      warn: ['image storage not ready: Error: Object storage is not configured: set S3_ENDPOINT.'],
    }
  );
  assert.deepEqual(
    await prepareStorage({
      pages: () => {
        throw new Error('AccessDenied');
      },
      images: notConfigured,
    }),
    {
      info: [],
      warn: [
        'page storage not ready: Error: AccessDenied',
        'image storage not ready: Error: Object storage is not configured: set S3_ENDPOINT.',
      ],
    }
  );
});
