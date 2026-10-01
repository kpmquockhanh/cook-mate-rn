import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// Set before anything reads them, and set to '' rather than deleted so
// dotenv (which never overrides an existing key) cannot fill them in from a
// developer's backend/.env.
process.env.S3_ENDPOINT = '';
process.env.S3_ACCESS_KEY_ID = '';
process.env.S3_SECRET_ACCESS_KEY = '';

const s3 = await import('../src/storage/s3.js');

type Handler = (command: unknown) => unknown;

/** A stand-in for S3Client: records every command (and its options) and answers with `handler`. */
function fakeClient(handler: Handler = () => ({})) {
  const sent: unknown[] = [];
  const options: ({ abortSignal?: AbortSignal } | undefined)[] = [];
  s3.setS3ClientForTests({
    async send(command: unknown, sendOptions?: { abortSignal?: AbortSignal }) {
      sent.push(command);
      options.push(sendOptions);
      return handler(command);
    },
  });
  return Object.assign(sent, { options });
}

/** An error shaped like the SDK's: a name plus the HTTP status in $metadata. */
function sdkError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

afterEach(() => {
  s3.setS3ClientForTests(null);
});

test('putObject sends the bucket, key, body, content type and cache control', async () => {
  const sent = fakeClient();
  const body = new Uint8Array([1, 2, 3]);

  await s3.putObject('recipe-images', 'ab/abc.png', body, {
    contentType: 'image/png',
    cacheControl: 'public, max-age=31536000, immutable',
  });

  assert.equal(sent.length, 1);
  const command = sent[0];
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, 'recipe-images');
  assert.equal(command.input.Key, 'ab/abc.png');
  assert.equal(command.input.Body, body);
  assert.equal(command.input.ContentType, 'image/png');
  assert.equal(command.input.CacheControl, 'public, max-age=31536000, immutable');
});

test('reads and writes carry an abort signal, so a hung store cannot stall a run', async () => {
  const sent = fakeClient(() => ({ Body: { transformToByteArray: async () => new Uint8Array() } }));
  await s3.putObject('raw-pages', 'aa/x.html.gz', new Uint8Array(), {
    contentType: 'application/gzip',
  });
  await s3.getObject('raw-pages', 'aa/x.html.gz');
  assert.ok(sent.options[0]?.abortSignal instanceof AbortSignal);
  assert.ok(sent.options[1]?.abortSignal instanceof AbortSignal);
});

test('getObject returns the object bytes', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const sent = fakeClient(() => ({ Body: { transformToByteArray: async () => bytes } }));

  assert.deepEqual(await s3.getObject('raw-pages', 'aa/x.html.gz'), bytes);
  const command = sent[0];
  assert.ok(command instanceof GetObjectCommand);
  assert.equal(command.input.Bucket, 'raw-pages');
  assert.equal(command.input.Key, 'aa/x.html.gz');
});

test('a missing object reads as null, whether the SDK says NoSuchKey or just 404', async () => {
  fakeClient(() => {
    throw sdkError('NoSuchKey', 404);
  });
  assert.equal(await s3.getObject('raw-pages', 'aa/gone.html.gz'), null);

  fakeClient(() => {
    throw sdkError('NotFound', 404);
  });
  assert.equal(await s3.getObject('raw-pages', 'aa/gone.html.gz'), null);
});

// A wrong RAW_PAGE_BUCKET would otherwise read as "every page is missing".
test('a missing bucket is rethrown, not read as a missing object', async () => {
  fakeClient(() => {
    throw sdkError('NoSuchBucket', 404);
  });
  await assert.rejects(
    s3.getObject('raw-pagez', 'aa/x.html.gz'),
    /S3 GetObject raw-pagez\/aa\/x\.html\.gz failed: NoSuchBucket/
  );
});

test('any other failure is rethrown naming the operation, bucket, key and error', async () => {
  const original = sdkError('AccessDenied', 403);
  fakeClient(() => {
    throw original;
  });

  await assert.rejects(
    s3.putObject('raw-pages', 'aa/x.html.gz', new Uint8Array(), {
      contentType: 'application/gzip',
    }),
    (error: Error) => {
      assert.match(error.message, /S3 PutObject raw-pages\/aa\/x\.html\.gz failed: AccessDenied/);
      assert.equal(error.cause, original);
      return true;
    }
  );
  await assert.rejects(
    s3.getObject('raw-pages', 'aa/x.html.gz'),
    /S3 GetObject raw-pages\/aa\/x\.html\.gz failed: AccessDenied/
  );
});

test('ensureBucket creates a missing private bucket and sets no policy', async () => {
  const sent = fakeClient((command) => {
    if (command instanceof HeadBucketCommand) throw sdkError('NotFound', 404);
    return {};
  });

  assert.deepEqual(await s3.ensureBucket('raw-pages', { public: false }), {
    created: true,
    publicPolicy: 'n/a',
  });
  assert.ok(sent[1] instanceof CreateBucketCommand);
  assert.equal(sent[1].input.Bucket, 'raw-pages');
  assert.equal(sent.length, 2);
});

test('ensureBucket leaves an existing private bucket alone', async () => {
  const sent = fakeClient();
  assert.deepEqual(await s3.ensureBucket('raw-pages', { public: false }), {
    created: false,
    publicPolicy: 'n/a',
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof HeadBucketCommand);
});

test('a new public bucket gets a policy allowing anonymous GetObject and nothing else', async () => {
  const sent = fakeClient((command) => {
    if (command instanceof HeadBucketCommand) throw sdkError('NotFound', 404);
    return {};
  });

  assert.deepEqual(await s3.ensureBucket('recipe-images', { public: true }), {
    created: true,
    publicPolicy: 'set',
  });

  const put = sent.find((command) => command instanceof PutBucketPolicyCommand);
  assert.ok(put instanceof PutBucketPolicyCommand);
  const policy = JSON.parse(put.input.Policy!);
  assert.deepEqual(policy.Statement, [
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::recipe-images/*'],
    },
  ]);
});

test('an existing public bucket with the read grant reports ok, in either policy spelling', async () => {
  // The second form is how MinIO stores what `mc anonymous set download` writes.
  for (const statement of [
    {
      Effect: 'Allow',
      Principal: '*',
      Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::recipe-images/*',
    },
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetBucketLocation', 's3:GetObject'],
      Resource: ['arn:aws:s3:::recipe-images/*'],
    },
  ]) {
    const sent = fakeClient((command) =>
      command instanceof GetBucketPolicyCommand
        ? { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [statement] }) }
        : {}
    );
    assert.deepEqual(await s3.ensureBucket('recipe-images', { public: true }), {
      created: false,
      publicPolicy: 'ok',
    });
    assert.ok(!sent.some((command) => command instanceof PutBucketPolicyCommand));
  }
});

/** The publicPolicy an existing public bucket reports with these policy statements. */
async function policyVerdict(...statements: object[]) {
  fakeClient((command) =>
    command instanceof GetBucketPolicyCommand
      ? { Policy: JSON.stringify({ Version: '2012-10-17', Statement: statements }) }
      : {}
  );
  return (await s3.ensureBucket('recipe-images', { public: true })).publicPolicy;
}

const anonymousRead = {
  Effect: 'Allow',
  Principal: '*',
  Action: 's3:GetObject',
  Resource: 'arn:aws:s3:::recipe-images/*',
};

test('wildcard actions and resources that cover GetObject on the bucket count as the read grant', async () => {
  for (const Action of ['s3:Get*', 's3:*', '*', 'S3:GETOBJECT']) {
    assert.equal(await policyVerdict({ ...anonymousRead, Action }), 'ok', Action);
  }
  for (const Resource of ['arn:aws:s3:::*', '*', 'arn:aws:s3:::recipe-images*']) {
    assert.equal(await policyVerdict({ ...anonymousRead, Resource }), 'ok', Resource);
  }
  assert.equal(await policyVerdict({ ...anonymousRead, Action: 's3:Put*' }), 'missing');
  assert.equal(
    await policyVerdict({ ...anonymousRead, Resource: 'arn:aws:s3:::recipe-images/public/*' }),
    'missing'
  );
});

test('a conditional grant is not public read', async () => {
  assert.equal(
    await policyVerdict({
      ...anonymousRead,
      Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } },
    }),
    'missing'
  );
});

test('an unconditional Deny on anonymous reads cancels the grant; a conditional one does not', async () => {
  const deny = { ...anonymousRead, Effect: 'Deny', Action: 's3:*' };
  assert.equal(await policyVerdict(anonymousRead, deny), 'missing');
  // The common "deny plain HTTP" statement must not read as "not public".
  assert.equal(
    await policyVerdict(anonymousRead, {
      ...deny,
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    }),
    'ok'
  );
});

test('an existing public bucket without the grant reports missing and writes nothing', async () => {
  // An operator's own policy is never overwritten; the check only reports.
  const sent = fakeClient((command) => {
    if (command instanceof GetBucketPolicyCommand) throw sdkError('NoSuchBucketPolicy', 404);
    return {};
  });

  assert.deepEqual(await s3.ensureBucket('recipe-images', { public: true }), {
    created: false,
    publicPolicy: 'missing',
  });
  assert.ok(!sent.some((command) => command instanceof PutBucketPolicyCommand));

  fakeClient((command) =>
    command instanceof GetBucketPolicyCommand
      ? {
          Policy: JSON.stringify({
            Statement: [
              {
                Effect: 'Allow',
                Principal: '*',
                Action: 's3:GetObject',
                Resource: 'arn:aws:s3:::other/*',
              },
            ],
          }),
        }
      : {}
  );
  assert.equal((await s3.ensureBucket('recipe-images', { public: true })).publicPolicy, 'missing');
});

test('without an injected client, missing configuration names every missing variable', () => {
  assert.throws(
    () => s3.s3Client(),
    (error: Error) => {
      assert.match(error.message, /S3_ENDPOINT/);
      assert.match(error.message, /S3_ACCESS_KEY_ID/);
      assert.match(error.message, /S3_SECRET_ACCESS_KEY/);
      assert.match(error.message, /RAW_PAGE_STORE=file/);
      // The file store is for raw pages only; images have no fallback.
      assert.match(error.message, /recipe images still need object storage/i);
      return true;
    }
  );

  process.env.S3_ENDPOINT = 'http://localhost:9000';
  process.env.S3_ACCESS_KEY_ID = 'minio';
  try {
    assert.throws(
      () => s3.s3Client(),
      (error: Error) => {
        assert.doesNotMatch(error.message, /S3_ENDPOINT/);
        assert.match(error.message, /S3_SECRET_ACCESS_KEY/);
        return true;
      }
    );
  } finally {
    process.env.S3_ENDPOINT = '';
    process.env.S3_ACCESS_KEY_ID = '';
  }
});

test('every ensureBucket call carries an abort signal, so a hung store cannot stall setup or a run', async () => {
  const created = fakeClient((command) => {
    if (command instanceof HeadBucketCommand) throw sdkError('NotFound', 404);
    return {};
  });
  await s3.ensureBucket('recipe-images', { public: true });
  assert.equal(created.length, 3); // HeadBucket, CreateBucket, PutBucketPolicy
  for (const options of created.options) assert.ok(options?.abortSignal instanceof AbortSignal);

  const existing = fakeClient((command) =>
    command instanceof GetBucketPolicyCommand ? { Policy: '{}' } : {}
  );
  await s3.ensureBucket('recipe-images', { public: true });
  assert.equal(existing.length, 2); // HeadBucket, GetBucketPolicy
  for (const options of existing.options) assert.ok(options?.abortSignal instanceof AbortSignal);
});

test('a network failure keeps its code and message, not just the generic name "Error"', async () => {
  // What the SDK surfaces when nothing listens on the endpoint: a plain Error
  // (often an AggregateError with an empty message) carrying only a code.
  fakeClient(() => {
    throw Object.assign(new AggregateError([], ''), { name: 'Error', code: 'ECONNREFUSED' });
  });
  await assert.rejects(
    s3.ensureBucket('raw-pages', { public: false }),
    /HeadBucket raw-pages failed: ECONNREFUSED/
  );

  fakeClient(() => {
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  });
  await assert.rejects(
    s3.getObject('raw-pages', 'aa/x.html.gz'),
    /GetObject raw-pages\/aa\/x\.html\.gz failed: ECONNRESET: socket hang up/
  );
});

test('an SDK error message names its HTTP status', async () => {
  fakeClient(() => {
    throw sdkError('AccessDenied', 403);
  });
  await assert.rejects(
    s3.putObject('raw-pages', 'aa/x.html.gz', new Uint8Array(), {
      contentType: 'application/gzip',
    }),
    /failed: AccessDenied \(HTTP 403\)/
  );
});

test('a policy with no statements reads as missing, not as a failed request', async () => {
  fakeClient((command) => (command instanceof GetBucketPolicyCommand ? { Policy: '{}' } : {}));
  assert.equal((await s3.ensureBucket('recipe-images', { public: true })).publicPolicy, 'missing');
});

test('S3 settings ignore whitespace pasted around them in .env', async () => {
  const { env } = await import('../src/env.js');
  const saved = { ...process.env };
  process.env.S3_ENDPOINT = ' http://localhost:9000/ ';
  process.env.S3_PUBLIC_URL = '  http://192.168.1.5:9000/\n';
  process.env.S3_REGION = ' us-east-1 ';
  process.env.S3_ACCESS_KEY_ID = ' minio ';
  process.env.S3_SECRET_ACCESS_KEY = '  ';
  try {
    assert.equal(env.s3Endpoint, 'http://localhost:9000');
    assert.equal(env.s3PublicUrl, 'http://192.168.1.5:9000');
    assert.equal(env.s3Region, 'us-east-1');
    assert.equal(env.s3AccessKeyId, 'minio');
    assert.equal(env.s3SecretAccessKey, undefined);
    process.env.S3_PUBLIC_URL = ' ';
    assert.equal(env.s3PublicUrl, 'http://localhost:9000');
  } finally {
    for (const key of [
      'S3_ENDPOINT',
      'S3_PUBLIC_URL',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
