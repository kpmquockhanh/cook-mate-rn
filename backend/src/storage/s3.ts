import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { env } from '../env.js';

/**
 * The one module that talks to object storage.
 *
 * Any S3-compatible store works; locally it is the MinIO service from
 * docker-compose.yml. Path-style addressing (`<endpoint>/<bucket>/<key>`) is
 * forced because MinIO, reached by IP or container name, has no per-bucket
 * hostnames - and it is also the URL shape EXPO_PUBLIC_STORAGE_URL relies on.
 *
 * pages.ts and images.ts own the buckets and the key layout; this module only
 * moves bytes and makes sure a bucket exists.
 */

/** The part of S3Client this module uses, so tests can hand in a fake. */
interface S3Like {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

let client: S3Like | null = null;

/** Test seam: use `fake` instead of a real client, or null to go back. */
export function setS3ClientForTests(fake: S3Like | null): void {
  client = fake;
}

/**
 * The shared client, built on first use. Throws, naming every missing
 * variable, when the store is not configured - so the crawler fails on its
 * first write with something actionable rather than a signing error.
 */
export function s3Client(): S3Like {
  if (client) return client;

  const endpoint = env.s3Endpoint;
  const accessKeyId = env.s3AccessKeyId;
  const secretAccessKey = env.s3SecretAccessKey;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    const missing = [
      !endpoint && 'S3_ENDPOINT',
      !accessKeyId && 'S3_ACCESS_KEY_ID',
      !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
    ].filter(Boolean);
    throw new Error(
      `Object storage is not configured: set ${missing.join(', ')}. ` +
        'For local crawling without an object store, set RAW_PAGE_STORE=file. See backend/.env.example.',
    );
  }

  client = new S3Client({
    endpoint,
    region: env.s3Region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  }) as S3Like;
  return client;
}

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function isNotFound(error: unknown, ...names: string[]): boolean {
  return status(error) === 404 || names.includes((error as Error)?.name);
}

/** Rethrown with enough context to find the object, keeping the SDK error as `cause`. */
function storageError(operation: string, bucket: string, key: string | null, error: unknown): Error {
  const target = key ? `${bucket}/${key}` : bucket;
  const reason = (error as Error)?.name || String(error);
  return new Error(`S3 ${operation} ${target} failed: ${reason}`, { cause: error });
}

export async function putObject(
  bucket: string,
  key: string,
  body: Uint8Array,
  options: { contentType: string; cacheControl?: string },
): Promise<void> {
  try {
    // Content-addressed keys mean a repeat write is the same bytes, so the
    // plain overwrite S3 does is always safe.
    await s3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
      { abortSignal: AbortSignal.timeout(env.crawlTimeoutMs) },
    );
  } catch (error) {
    throw storageError('PutObject', bucket, key, error);
  }
}

/** The object's bytes, or null when there is no such object. */
export async function getObject(bucket: string, key: string): Promise<Uint8Array | null> {
  try {
    const response = (await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(env.crawlTimeoutMs),
    })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!response.Body) return null;
    return await response.Body.transformToByteArray();
  } catch (error) {
    if (isNotFound(error, 'NoSuchKey', 'NotFound')) return null;
    throw storageError('GetObject', bucket, key, error);
  }
}

export interface BucketReport {
  created: boolean;
  /**
   * For a public bucket: `set` when we just wrote the read policy, `ok` when
   * one is already there, `missing` when an existing bucket lacks it (left
   * alone - an operator's policy is never overwritten). `n/a` when private.
   */
  publicPolicy: 'ok' | 'set' | 'missing' | 'n/a';
}

/** Anonymous read of objects only - no listing, no writes. */
function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** True when `policy` lets anyone GetObject on every key in `bucket`. */
function grantsPublicRead(policy: string, bucket: string): boolean {
  let statements: unknown[];
  try {
    statements = asList((JSON.parse(policy) as { Statement?: unknown }).Statement);
  } catch {
    return false;
  }
  return statements.some((raw) => {
    const statement = raw as { Effect?: string; Principal?: unknown; Action?: unknown; Resource?: unknown };
    const principal = statement.Principal;
    const anyone =
      principal === '*' || asList((principal as { AWS?: unknown } | undefined)?.AWS).includes('*');
    return (
      statement.Effect === 'Allow' &&
      anyone &&
      asList(statement.Action).some((action) => action === 's3:GetObject' || action === 's3:*') &&
      asList(statement.Resource).includes(`arn:aws:s3:::${bucket}/*`)
    );
  });
}

/** Create the bucket if it is missing; for a public one, make sure anyone can read it. */
export async function ensureBucket(bucket: string, options: { public: boolean }): Promise<BucketReport> {
  const s3 = s3Client();

  let created = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isNotFound(error, 'NotFound', 'NoSuchBucket')) throw storageError('HeadBucket', bucket, null, error);
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (createError) {
      throw storageError('CreateBucket', bucket, null, createError);
    }
    created = true;
  }

  if (!options.public) return { created, publicPolicy: 'n/a' };

  if (created) {
    try {
      await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
    } catch (error) {
      throw storageError('PutBucketPolicy', bucket, null, error);
    }
    return { created, publicPolicy: 'set' };
  }

  try {
    const { Policy } = (await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }))) as { Policy?: string };
    return { created, publicPolicy: Policy && grantsPublicRead(Policy, bucket) ? 'ok' : 'missing' };
  } catch (error) {
    if (isNotFound(error, 'NoSuchBucketPolicy')) return { created, publicPolicy: 'missing' };
    throw storageError('GetBucketPolicy', bucket, null, error);
  }
}
