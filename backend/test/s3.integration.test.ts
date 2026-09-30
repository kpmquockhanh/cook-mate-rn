import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../src/env.js';
import { ensureBucket, getObject, putObject, s3Client } from '../src/storage/s3.js';

/**
 * Runs against a real MinIO (docker compose up -d minio) when one is
 * configured and answering, and skips otherwise - the same pattern as the
 * database tests, so `npm test` stays green in CI with no object store.
 * It uses the real buckets, so it also checks what the app depends on: that
 * the image bucket is readable without credentials.
 */
async function skipReason(): Promise<string | false> {
  if (!env.s3Endpoint || !env.s3AccessKeyId || !env.s3SecretAccessKey) return 'S3_* not set';
  try {
    await fetch(env.s3Endpoint, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return `no object store answering at ${env.s3Endpoint}`;
  }
}

const skip = await skipReason();

test('an object round-trips through the private bucket', { skip }, async () => {
  const bucket = env.rawPageBucket;
  const key = `integration-test/${randomUUID()}.bin`;
  const body = new Uint8Array([1, 2, 3, 4]);

  await ensureBucket(bucket, { public: false });
  try {
    await putObject(bucket, key, body, { contentType: 'application/octet-stream' });
    assert.deepEqual(await getObject(bucket, key), body);
  } finally {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  assert.equal(await getObject(bucket, key), null);
});

test('an object in the image bucket is readable anonymously at the public URL', { skip }, async () => {
  const bucket = env.recipeImageBucket;
  const key = `integration-test/${randomUUID()}.png`;

  const report = await ensureBucket(bucket, { public: true });
  assert.notEqual(report.publicPolicy, 'missing', `bucket "${bucket}" has no anonymous read policy`);
  try {
    await putObject(bucket, key, new Uint8Array([137, 80, 78, 71]), { contentType: 'image/png' });
    const response = await fetch(`${env.s3PublicUrl}/${bucket}/${key}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
});
