import { randomUUID } from 'node:crypto';
import { type LogLine, type LogSink, logger, withLogSink } from '../log.js';
import { acquireJobLock } from './locks.js';
import { runLog, withRunObserver } from './runs.js';

export type JobKind =
  | 'discover'
  | 'crawl'
  | 'extract'
  | 'parse'
  | 'images'
  | 'enrich'
  | 'gate'
  | 'publish'
  | 'pipeline';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobContext {
  /** Aborted when someone cancels the job. Long stages must poll it. */
  readonly signal: AbortSignal;
  readonly log: ReturnType<typeof logger>;
  /** Merge counters into the job's live progress object. */
  progress(update: Record<string, unknown>): void;
}

export interface JobView {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  params: Record<string, unknown>;
  progress: Record<string, unknown>;
  result?: unknown;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** Sequence number of the newest log line held for this job. */
  logCursor: number;
  /** Lines evicted by the per-job cap, so the UI can say so rather than lie. */
  logDropped: number;
  /** The run this job started, when it started exactly one. */
  runId: number | null;
  /**
   * Where this job's lines are read from. 'run' means the stored log in
   * Postgres, which outlives both the job and this process; 'memory' is the
   * in-process buffer below, and is all a job without a run of its own has.
   */
  logSource: 'run' | 'memory';
}

interface SeqLine extends LogLine {
  seq: number;
}

interface JobRecord extends JobView {
  lines: SeqLine[];
  controller: AbortController;
}

/**
 * Jobs live in this process only. That is the right trade for an operator
 * console: it is started by hand, it drives a pipeline whose real state is in
 * Postgres, and a restart losing the log scrollback of a finished run costs
 * nothing. Nothing here is a substitute for the database.
 */
const jobs = new Map<string, JobRecord>();

const MAX_JOBS = 40;
const MAX_LINES_PER_JOB = 2000;

function view(job: JobRecord): JobView {
  const { lines: _lines, controller: _controller, ...rest } = job;
  return rest;
}

function prune() {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
  for (const job of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.id);
}

export function runningJob(kind: JobKind): JobView | null {
  for (const job of jobs.values()) {
    if (job.kind === kind && job.status === 'running') return view(job);
  }
  return null;
}

/**
 * Start a job and return once it is running. Refuses a second job of the same
 * kind: two `crawl` runs would race for the same queue rows, and two `enrich`
 * runs would spend the model budget twice on the same staging rows.
 *
 * The refusal is enforced by a Postgres advisory lock rather than by the map
 * below, because this console is not the only thing that drives the pipeline.
 * A CLI `crawl` on someone's laptop and a console `crawl` in the container are
 * different processes against one database, and an in-process guard cannot see
 * across that. The map is still checked first: it costs nothing and gives the
 * common case a better message than the lock can.
 */
export async function startJob(
  kind: JobKind,
  label: string,
  params: Record<string, unknown>,
  fn: (ctx: JobContext) => Promise<unknown>,
): Promise<JobView> {
  const existing = runningJob(kind);
  if (existing) {
    throw Object.assign(new Error(`a ${kind} job is already running`), { status: 409 });
  }

  const lock = await acquireJobLock(kind);
  if (!lock) {
    throw Object.assign(
      new Error(`a ${kind} job is already running in another process`),
      { status: 409 },
    );
  }

  const controller = new AbortController();
  const job: JobRecord = {
    id: randomUUID(),
    kind,
    label,
    status: 'running',
    params,
    progress: {},
    startedAt: new Date().toISOString(),
    logCursor: 0,
    logDropped: 0,
    runId: null,
    logSource: 'memory',
    lines: [],
    controller,
  };

  const sink: LogSink = (line) => {
    job.logCursor += 1;
    job.lines.push({ ...line, seq: job.logCursor });
    if (job.lines.length > MAX_LINES_PER_JOB) {
      job.logDropped += job.lines.length - MAX_LINES_PER_JOB;
      job.lines.splice(0, job.lines.length - MAX_LINES_PER_JOB);
    }
  };

  const ctx: JobContext = {
    signal: controller.signal,
    log: logger(kind),
    progress(update) {
      Object.assign(job.progress, update);
    },
  };

  /**
   * A stage that records a run stores its own log, and that copy is the one
   * the console reads: it is complete, it survives a restart, and it is still
   * there next week. `pipeline` is the exception - it spans several runs plus
   * stages that record none, so no single run's log is the job's log and it
   * keeps the in-memory buffer above.
   */
  const observe = (run: { id: number }) => {
    if (job.kind === 'pipeline' || job.runId !== null) return;
    job.runId = run.id;
    job.logSource = 'run';
  };

  // Deliberately not awaited: startJob returns as soon as the job is running,
  // and the chain below handles every outcome, so nothing can go unhandled.
  void withRunObserver(observe, () =>
    withLogSink(sink, async () => {
      job.result = await fn(ctx);
    }),
  )
    .then(() => {
      job.status = controller.signal.aborted ? 'cancelled' : 'done';
    })
    .catch((error: unknown) => {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      sink({
        ts: new Date().toISOString(),
        level: 'error',
        scope: kind,
        message: job.error,
      });
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      prune();
    })
    // The lock outlives the job's own bookkeeping, so release it last and
    // never let a release failure resurface as an unhandled rejection: the
    // job itself has already been accounted for above.
    .finally(() => {
      void lock.release();
    });

  jobs.set(job.id, job);
  return view(job);
}

export function listJobs(): JobView[] {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(view);
}

export interface JobDetail extends JobView {
  lines: SeqLine[];
}

/**
 * `since` is a log cursor: only lines newer than it come back. Which cursor it
 * counts in depends on `logSource` - a stored run's seq, or this process's
 * per-job sequence - so a caller that sees the source change must start again
 * from 0 rather than carry its old cursor across.
 */
export async function getJob(id: string, since = 0): Promise<JobDetail | null> {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.logSource === 'run' && job.runId !== null) {
    const lines = await runLog(job.runId, since);
    return {
      ...view(job),
      // The stored log's own numbering, not the in-memory one: what the caller
      // sends back as `since` has to mean the same thing next time.
      logCursor: lines.length > 0 ? lines[lines.length - 1]!.seq : since,
      lines: lines.map((line) => ({
        seq: line.seq,
        ts: line.ts,
        level: line.level as LogLine['level'],
        scope: line.scope,
        message: line.message,
        extra: line.extra ?? undefined,
      })),
    };
  }
  return { ...view(job), lines: job.lines.filter((line) => line.seq > since) };
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  return true;
}
