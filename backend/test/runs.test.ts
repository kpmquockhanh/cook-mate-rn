import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuns, statusCounterName } from '../src/jobs/runs.js';

test('server errors bucket together, everything else stays exact', () => {
  // A 500 and a 503 both mean "back off", and one counter per distinct 5xx
  // would spread a single outage across several names.
  assert.equal(statusCounterName(500), 'http_5xx');
  assert.equal(statusCounterName(503), 'http_5xx');
  assert.equal(statusCounterName(599), 'http_5xx');

  // A 404 and a 403 call for different responses, so they stay apart.
  assert.equal(statusCounterName(200), 'http_200');
  assert.equal(statusCounterName(304), 'http_304');
  assert.equal(statusCounterName(404), 'http_404');
  assert.equal(statusCounterName(429), 'http_429');
});

test('two runs line up counter by counter', () => {
  const deltas = compareRuns(
    { pages_fetched: 48, http_200: 12, http_304: 34, failed_no_markup: 19 },
    { pages_fetched: 50, http_200: 47, http_304: 0, failed_no_markup: 3 },
  );

  const by = Object.fromEntries(deltas.map((d) => [d.name, d]));
  assert.equal(by.failed_no_markup!.change, 16);
  assert.equal(by.http_304!.change, 34);
  assert.equal(by.pages_fetched!.change, -2);
});

test('a counter absent from one side is reported, not dropped', () => {
  // A counter that stopped appearing is itself the finding: it can mean a fix
  // landed, or that the stage producing it never ran.
  const deltas = compareRuns({ extracted: 5 }, { extracted: 4, failed_error: 2 });
  const names = deltas.map((d) => d.name);
  assert.deepEqual(names, ['extracted', 'failed_error']);

  const gone = deltas.find((d) => d.name === 'failed_error')!;
  assert.equal(gone.current, 0);
  assert.equal(gone.previous, 2);
  assert.equal(gone.change, -2);
});

test('the first run of all has no baseline, so nothing is called growth', () => {
  const deltas = compareRuns({ pages_fetched: 10 }, null);
  assert.equal(deltas[0]!.previous, null);
  // Not 10: appearing for the first time is not an increase of 10.
  assert.equal(deltas[0]!.change, null);
});
