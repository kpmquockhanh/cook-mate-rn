import { AsyncLocalStorage } from 'node:async_hooks';

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  ts: string;
  level: Level;
  scope: string;
  message: string;
  extra?: string;
}

export type LogSink = (line: LogLine) => void;

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

/**
 * Lets a caller capture the lines produced by whatever it runs - the job runner
 * behind the console UI is the only user - without every pipeline stage having
 * to thread a logger argument through its call graph. AsyncLocalStorage is what
 * keeps two concurrent jobs apart: a line belongs to the job whose async
 * context emitted it, so `crawl` and `enrich` running side by side do not
 * interleave into one another's log panel.
 */
const sinks = new AsyncLocalStorage<LogSink>();

export function withLogSink<T>(sink: LogSink, fn: () => Promise<T>): Promise<T> {
  return sinks.run(sink, fn);
}

function emit(level: Level, scope: string, message: string, extra?: unknown) {
  if (order[level] < threshold) return;
  const serialized =
    extra === undefined ? undefined : typeof extra === 'string' ? extra : JSON.stringify(extra);
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (serialized === undefined) console.log(line);
  else console.log(line, serialized);

  // A broken sink must never take the process down with it: the log call sites
  // are everywhere and none of them expect logging to throw.
  const sink = sinks.getStore();
  if (sink) {
    try {
      sink({ ts, level, scope, message, extra: serialized });
    } catch {
      /* ignore */
    }
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
