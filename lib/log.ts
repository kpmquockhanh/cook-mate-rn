/**
 * Scoped console logging for the app.
 *
 * A voice session can only ever tell the user a summary ("assistant
 * unavailable"), so the detail behind it has to land somewhere a developer can
 * read: the Metro console in dev, the device log in a release build.
 *
 * debug/info are dropped outside dev so a shipped build does not narrate
 * itself. warn and error always emit - those are what a bug report needs.
 */

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

export interface Logger {
  debug: (message: string, extra?: unknown) => void;
  info: (message: string, extra?: unknown) => void;
  warn: (message: string, extra?: unknown) => void;
  error: (message: string, extra?: unknown) => void;
}

/**
 * React Native's console prints a plain object as `[object Object]`, which is
 * exactly the shape most Supabase and LiveKit errors arrive in. Errors pass
 * through untouched because the console does render those with their stack.
 */
function readable(extra: unknown): unknown {
  if (extra instanceof Error || extra === null || typeof extra !== 'object') return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return extra;
  }
}

function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  scope: string,
  message: string,
  extra?: unknown
) {
  if (!isDev && (level === 'debug' || level === 'info')) return;

  const line = `[${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, readable(extra));
}

export function logger(scope: string): Logger {
  return {
    debug: (message, extra) => emit('debug', scope, message, extra),
    info: (message, extra) => emit('info', scope, message, extra),
    warn: (message, extra) => emit('warn', scope, message, extra),
    error: (message, extra) => emit('error', scope, message, extra),
  };
}

/** Best-effort human-readable text for anything that was thrown or rejected. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}
