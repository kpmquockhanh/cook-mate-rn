import { AsyncLocalStorage } from 'node:async_hooks';
import { query } from '../db.js';
import { type LogLine, type LogSink, logger, withLogSink } from '../log.js';

const log = logger('runs');

export type RunKind = 'crawl' | 'discover' | 'extract';
export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface RunRow {
  id: number;
  kind: string;
  status: RunStatus;
  params: Record<string, unknown>;
  counters: Record<string, number>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** One stored line of a run's log, as it comes back out of the database. */
export interface RunLogRow {
  seq: number;
  ts: string;
  level: string;
  scope: string;
  message: string;
  extra: string | null;
}

/**
 * Server errors are bucketed and everything else is kept exact. A 503 and a 500
 * call for the same response - back off - while a 404 and a 403 do not, and one
 * counter per distinct 5xx would spread one outage across several names.
 */
export function statusCounterName(status: number): string {
  return status >= 500 ? 'http_5xx' : `http_${status}`;
}

export interface CounterDelta {
  name: string;
  current: number;
  previous: number | null;
  /** Null when this counter is new, so "appeared" is not reported as growth. */
  change: number | null;
}

/**
 * Line up two runs' counters so one can be read against the other.
 *
 * A column of numbers from a single run answers nothing; "did last night go
 * worse" is a comparison. Counters missing from either side are still listed,
 * because a counter that stopped appearing is itself the finding - no
 * `failed_no_markup` this run could mean a fix landed, or that nothing ran.
 */
export function compareRuns(
  current: Record<string, number>,
  previous: Record<string, number> | null,
): CounterDelta[] {
  const names = [...new Set([...Object.keys(current), ...Object.keys(previous ?? {})])].sort();
  return names.map((name) => {
    const now = current[name] ?? 0;
    const before = previous ? (previous[name] ?? 0) : null;
    return {
      name,
      current: now,
      previous: before,
      change: before === null ? null : now - before,
    };
  });
}

/** How often a still-running run's counters reach the database. */
const FLUSH_INTERVAL_MS = 5000;

/**
 * How often buffered log lines are written. Shorter than the counter flush
 * because the log is now what someone watches a run through: a line that takes
 * five seconds to appear reads as a stall.
 */
const LOG_FLUSH_INTERVAL_MS = 1000;

/**
 * Lines stored per run. A crawl of a few hundred URLs logs a few hundred
 * lines; a run that logs a hundred thousand is a loop, and storing all of it
 * would cost more than reading it is worth. The overflow is counted in
 * `log_lines_dropped` so the log never quietly lies about being complete.
 */
const MAX_LOG_LINES_PER_RUN = 20_000;

/** Rows per insert, so one slow batch cannot hold a chatty run open. */
const LOG_BATCH_SIZE = 500;

/**
 * A run in progress.
 *
 * Counters accumulate in memory and are flushed on a timer as well as at the
 * end, because a run that dies is exactly the run whose numbers are most worth
 * having. The in-memory copy is a write buffer, never the record - the job
 * runner already keeps live state and it does not survive a restart.
 */
export class Run {
  private readonly counters = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  /** Lines waiting to be written, and the number already written. */
  private pending: (LogLine & { seq: number })[] = [];
  private logSeq = 0;
  private logDropped = 0;
  private logTimer: NodeJS.Timeout | null = null;
  /** Serializes log writes, so batches reach the table in order. */
  private logWrite: Promise<void> = Promise.resolve();

  private constructor(readonly id: number, readonly kind: RunKind) {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.logTimer = setInterval(() => {
      void this.flushLog();
    }, LOG_FLUSH_INTERVAL_MS);
    // A pending flush must never be the reason a CLI command will not exit.
    this.timer.unref?.();
    this.logTimer.unref?.();
  }

  static async start(kind: RunKind, params: Record<string, unknown> = {}): Promise<Run> {
    const rows = await query<{ id: number }>(
      `insert into crawler.crawl_runs (kind, params) values ($1, $2) returning id`,
      [kind, JSON.stringify(params)],
    );
    return new Run(rows[0]!.id, kind);
  }

  /** Add to a counter. Unknown names are created, so a new one costs nothing. */
  bump(name: string, by = 1): void {
    if (by === 0) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
    this.dirty = true;
  }

  /** Record an HTTP status in the distribution. */
  bumpStatus(status: number): void {
    this.bump(statusCounterName(status));
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /**
   * Buffer a log line for this run. Called from the sink `withRun` installs,
   * so every line a stage emits inside the run is captured without the stage
   * knowing the run exists.
   */
  appendLog(line: LogLine): void {
    if (this.pending.length + this.logSeq >= MAX_LOG_LINES_PER_RUN) {
      this.logDropped += 1;
      return;
    }
    this.pending.push({ ...line, seq: this.logSeq + this.pending.length + 1 });
  }

  private flushLog(): Promise<void> {
    if (this.pending.length === 0) return this.logWrite;
    const batch = this.pending.splice(0, LOG_BATCH_SIZE);
    // Chained rather than awaited in place: two timer ticks overlapping would
    // otherwise interleave batches and scramble the order lines are read in.
    this.logWrite = this.logWrite.then(() => this.writeBatch(batch));
    return this.logWrite;
  }

  private async writeBatch(batch: (LogLine & { seq: number })[]): Promise<void> {
    try {
      await query(
        `insert into crawler.crawl_run_logs (run_id, seq, ts, level, scope, message, extra)
         select $1, *
           from unnest($2::int[], $3::timestamptz[], $4::text[], $5::text[], $6::text[], $7::text[])
         on conflict (run_id, seq) do nothing`,
        [
          this.id,
          batch.map((line) => line.seq),
          batch.map((line) => line.ts),
          batch.map((line) => line.level),
          batch.map((line) => line.scope),
          batch.map((line) => line.message),
          batch.map((line) => line.extra ?? null),
        ],
      );
      this.logSeq = Math.max(this.logSeq, batch[batch.length - 1]!.seq);
    } catch (error) {
      // The log is a record of the run, not the run itself: a failed write
      // costs those lines and nothing else. Re-queueing risks a run that
      // cannot reach the database growing its buffer without bound.
      this.logSeq = Math.max(this.logSeq, batch[batch.length - 1]!.seq);
      this.logDropped += batch.length;
      log.debug(`log flush failed for run #${this.id}`, String(error));
    }
  }

  /** Write everything buffered, however many batches that takes. */
  private async drainLog(): Promise<void> {
    while (this.pending.length > 0) await this.flushLog();
    await this.logWrite;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await query(`update crawler.crawl_runs set counters = $2 where id = $1`, [
        this.id,
        JSON.stringify(this.snapshot()),
      ]);
    } catch (error) {
      // Losing a counter must never take down the run producing it.
      this.dirty = true;
      log.debug(`counter flush failed for run #${this.id}`, String(error));
    }
  }

  async finish(status: Exclude<RunStatus, 'running'>, error?: string): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
    this.dirty = false;
    // Before the counters, so `log_lines_dropped` is counted into the snapshot
    // the row ends up with.
    await this.drainLog();
    if (this.logDropped > 0) this.bump('log_lines_dropped', this.logDropped);
    await query(
      `update crawler.crawl_runs
          set status = $2, counters = $3, error = $4, finished_at = now()
        where id = $1`,
      [this.id, status, JSON.stringify(this.snapshot()), error ?? null],
    );
  }
}

/**
 * Told about each run started inside it, so a caller that did not start the
 * run - the console's job runner, which only knows it invoked `crawl` - can
 * still find out which run id to read the stored log from.
 */
const observers = new AsyncLocalStorage<(run: Run) => void>();

export function withRunObserver<T>(onRun: (run: Run) => void, fn: () => Promise<T>): Promise<T> {
  return observers.run(onRun, fn);
}

/**
 * Wrap a stage so its run is recorded whatever happens to it. A stage that
 * throws still leaves a row saying it failed and how far it got, which is the
 * case where the counters matter most.
 *
 * The log is captured the same way: every line emitted inside `body` is
 * buffered onto the run and written as it goes, so the run is readable from
 * the database while it is still going and still readable tomorrow.
 */
export async function withRun<T>(
  kind: RunKind,
  params: Record<string, unknown>,
  body: (run: Run) => Promise<T>,
): Promise<T> {
  const run = await Run.start(kind, params);
  observers.getStore()?.(run);
  const sink: LogSink = (line) => run.appendLog(line);
  try {
    const result = await withLogSink(sink, () => body(run));
    await run.finish('done');
    return result;
  } catch (error) {
    // finish() drains the buffer, so the lines leading up to the failure are
    // stored even though the stage never returned.
    await run.finish('failed', String(error));
    throw error;
  }
}

/**
 * A run's stored log, oldest first. `since` is a seq: the console polls with
 * the last line it has, and a reader opening a finished run passes 0.
 */
export async function runLog(runId: number, since = 0, limit = 2000): Promise<RunLogRow[]> {
  return query<RunLogRow>(
    // `ts` is formatted rather than handed over as a timestamp so a line reads
    // the same whether it came from the buffer or the table: an ISO string.
    `select seq,
            to_char(ts at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ts,
            level, scope, message, extra
       from crawler.crawl_run_logs
      where run_id = $1 and seq > $2
      order by seq
      limit $3`,
    [runId, since, limit],
  );
}

export async function getRun(id: number): Promise<RunRow | null> {
  const rows = await query<RunRow>(
    `select id, kind, status, params, counters, error, started_at, finished_at
       from crawler.crawl_runs where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function recentRuns(kind?: RunKind, limit = 20): Promise<RunRow[]> {
  return query<RunRow>(
    `select id, kind, status, params, counters, error, started_at, finished_at
       from crawler.crawl_runs
      ${kind ? 'where kind = $2' : ''}
      order by started_at desc
      limit $1`,
    kind ? [limit, kind] : [limit],
  );
}

/**
 * Print one run's stored log, oldest first.
 *
 * The log used to exist only in the console's memory while the run was on
 * screen, which meant a crawl started from the terminal and left overnight was
 * only ever readable by whoever was watching the terminal. It is a table now,
 * so it can be read afterwards, from anywhere, including here.
 */
export async function printRunLog(runId: number, limit = 10_000): Promise<void> {
  const run = await getRun(runId);
  if (!run) {
    console.log(`No run #${runId}.`);
    return;
  }

  const when = new Date(run.started_at).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`#${run.id}  ${run.kind}  ${run.status}  started ${when}`);
  if (run.error) console.log(`      error: ${run.error}`);

  let since = 0;
  let printed = 0;
  for (;;) {
    const lines = await runLog(runId, since, Math.min(1000, limit - printed));
    if (lines.length === 0) break;
    for (const line of lines) {
      console.log(
        `${line.ts} ${line.level.toUpperCase().padEnd(5)} [${line.scope}] ${line.message}` +
          (line.extra ? ` ${line.extra}` : ''),
      );
    }
    since = lines[lines.length - 1]!.seq;
    printed += lines.length;
    if (printed >= limit) break;
  }

  if (printed === 0) console.log('(no lines stored for this run)');
  const dropped = run.counters.log_lines_dropped;
  if (dropped) console.log(`\n(${dropped} line(s) dropped: the run exceeded the stored-log cap)`);
}

/**
 * Print recent runs as a matrix: one row per counter, one column per run,
 * oldest on the left.
 *
 * Deliberately not one block of numbers per run. The question this exists to
 * answer is whether tonight went worse than last night, and that is only
 * readable when the runs sit side by side - a column of `failed_no_markup`
 * climbing 2, 3, 19 is obvious across, and invisible down.
 */
export async function printRuns(kind?: RunKind, limit = 10): Promise<void> {
  const runs = (await recentRuns(kind, limit)).reverse();
  if (runs.length === 0) {
    console.log('No runs recorded yet.');
    return;
  }

  for (const run of runs) {
    const when = new Date(run.started_at).toISOString().replace('T', ' ').slice(0, 16);
    const took = run.finished_at
      ? `${Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000)}s`
      : 'running';
    const params = Object.entries(run.params)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    console.log(
      `#${run.id}  ${run.kind.padEnd(8)} ${when}  ${took.padStart(7)}  ${run.status}` +
        (params ? `  (${params})` : ''),
    );
    if (run.error) console.log(`      error: ${run.error}`);
  }

  // Union of every counter present, so a counter added later still lines up
  // with the runs that predate it.
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.counters)))].sort();
  if (names.length === 0) {
    console.log('\n(no counters recorded)');
    return;
  }

  const labelWidth = Math.max(12, ...names.map((name) => name.length));
  const columns = runs.map((run) => `#${run.id}`);
  const columnWidth = Math.max(7, ...columns.map((c) => c.length));

  console.log(
    `\n${''.padEnd(labelWidth)}  ${columns.map((c) => c.padStart(columnWidth)).join('  ')}`,
  );
  for (const name of names) {
    const cells = runs.map((run) => {
      const value = run.counters[name];
      // A dash, not a zero: the counter did not exist for that run, which is
      // not the same as having counted nothing.
      return (value === undefined ? '-' : String(value)).padStart(columnWidth);
    });
    console.log(`${name.padEnd(labelWidth)}  ${cells.join('  ')}`);
  }
  console.log('');
}
