import { randomUUID } from 'node:crypto';
import { type LogLine, type LogSink, logger, withLogSink } from '../log.js';

export type JobKind =
  | 'discover'
  | 'crawl'
  | 'parse'
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
 * Start a job and return immediately. Refuses a second job of the same kind:
 * two `crawl` runs would race for the same queue rows, and two `enrich` runs
 * would spend the model budget twice on the same staging rows.
 */
export function startJob(
  kind: JobKind,
  label: string,
  params: Record<string, unknown>,
  fn: (ctx: JobContext) => Promise<unknown>,
): JobView {
  const existing = runningJob(kind);
  if (existing) {
    throw Object.assign(new Error(`a ${kind} job is already running`), { status: 409 });
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

  // Deliberately not awaited: startJob returns as soon as the job is running,
  // and the chain below handles every outcome, so nothing can go unhandled.
  void withLogSink(sink, async () => {
    job.result = await fn(ctx);
  })
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

/** `since` is a log cursor: only lines newer than it come back. */
export function getJob(id: string, since = 0): JobDetail | null {
  const job = jobs.get(id);
  if (!job) return null;
  return { ...view(job), lines: job.lines.filter((line) => line.seq > since) };
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  return true;
}
