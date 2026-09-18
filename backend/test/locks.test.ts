import assert from 'node:assert/strict';
import test from 'node:test';

// The whole point of these locks is that they live in Postgres rather than in
// this process, so there is nothing to test without one. Skip rather than fail
// when there is none, so `npm test` stays green offline and in CI without
// secrets - but load the project's .env first, the way every entry point does,
// so a developer with a working database actually runs these instead of
// watching them skip.
async function skipReason(): Promise<string | false> {
  await import('dotenv/config');
  if (!process.env.DATABASE_URL) return 'DATABASE_URL not set';
  try {
    const { query } = await import('../src/db.js');
    await query('select 1');
    return false;
  } catch (error) {
    return `database unreachable (${String(error).slice(0, 60)})`;
  }
}

const skip = await skipReason();

test('job locks', { skip }, async (t) => {
  const { acquireJobLock, withJobLock } = await import('../src/jobs/locks.js');
  const { close, pool } = await import('../src/db.js');

  await t.test('a second holder is refused until the first releases', async () => {
    const first = await acquireJobLock('crawl');
    assert.ok(first, 'the first acquire should succeed');
    assert.equal(await acquireJobLock('crawl'), null);

    await first.release();
    const second = await acquireJobLock('crawl');
    assert.ok(second, 'the lock should be free once released');
    await second.release();
  });

  await t.test('unrelated stages do not block each other', async () => {
    const crawl = await acquireJobLock('crawl');
    const publish = await acquireJobLock('publish');
    assert.ok(crawl);
    assert.ok(publish, 'publish and crawl touch different rows and may overlap');
    await crawl.release();
    await publish.release();
  });

  await t.test('pipeline holds the stages it runs itself', async () => {
    const pipeline = await acquireJobLock('pipeline');
    assert.ok(pipeline);
    // Mirroring is one of them: two processes downloading the same recipe's
    // photos at once would hammer the source and race on the same row.
    assert.equal(await acquireJobLock('images'), null);
    // A console pipeline is running crawl internally, so a CLI crawl must not
    // start beside it even though nothing called it a "pipeline".
    assert.equal(await acquireJobLock('crawl'), null);
    assert.equal(await acquireJobLock('gate'), null);
    await pipeline.release();
    const crawl = await acquireJobLock('crawl');
    assert.ok(crawl);
    await crawl.release();
  });

  await t.test('a partly-taken set is given back, not stranded', async () => {
    // pipeline covers crawl, so pipeline cannot start - and must not walk away
    // still holding the locks it managed to take before finding out.
    const crawl = await acquireJobLock('crawl');
    assert.ok(crawl);
    assert.equal(await acquireJobLock('pipeline'), null);
    await crawl.release();

    const pipeline = await acquireJobLock('pipeline');
    assert.ok(pipeline, 'the failed attempt must not have stranded any key');
    await pipeline.release();
  });

  await t.test('releasing does not poison the pooled connection', async () => {
    // Releasing a client hands the live connection back to the pool. If the
    // unlock were skipped, the lock would travel with it and the next caller
    // to be handed that connection would hold a lock it never took. Cycling
    // more times than the pool is wide is what surfaces that.
    const cycles = pool().options.max! + 2;
    for (let i = 0; i < cycles; i++) {
      const lock = await acquireJobLock('gate');
      assert.ok(lock, `acquire ${i + 1} of ${cycles} should succeed`);
      await lock.release();
    }
  });

  await t.test('withJobLock refuses with a 409 and still frees the lock', async () => {
    const held = await acquireJobLock('enrich');
    assert.ok(held);

    await assert.rejects(
      () => withJobLock('enrich', async () => 'never runs'),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 409);
        assert.match(error.message, /already running/);
        return true;
      },
    );
    await held.release();

    assert.equal(await withJobLock('enrich', async () => 'ran'), 'ran');
    // And the body throwing must not strand it either.
    await assert.rejects(() =>
      withJobLock('enrich', async () => {
        throw new Error('boom');
      }),
    );
    const after = await acquireJobLock('enrich');
    assert.ok(after, 'a thrown body must still release the lock');
    await after.release();
  });

  await close();
});
