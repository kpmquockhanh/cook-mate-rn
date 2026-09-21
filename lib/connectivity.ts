import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { env } from './env';
import { logger } from './log';

const log = logger('connectivity');

/**
 * Whether the app can currently reach its API, and what to do about it when it
 * cannot.
 *
 * There is no native reachability module in the app (and adding one means a
 * native rebuild), so this is driven by what actually happens to requests:
 * apiFetch reports every transport failure and every success here. That is
 * also the more honest signal - a phone with full bars and a dead API is just
 * as unusable as one in a tunnel.
 *
 * Once a failure is reported, a probe loop takes over: it polls the API's
 * /health route with exponential backoff until it answers, then flips back to
 * 'online' and tells every `onReconnect` subscriber, which is how screens that
 * failed while offline load themselves again without the user pulling to
 * refresh.
 *
 * Offline vs server-down: when /health cannot be reached at all, Supabase is
 * tried too. If Supabase answers, the network is fine and it is our server
 * that is down; if neither answers, the device is offline. The two get
 * different wording because they ask different things of the user.
 */

export type ConnectionStatus = 'online' | 'offline' | 'server-down';

export interface ConnectivityState {
  status: ConnectionStatus;
  /** A probe is in flight right now. */
  checking: boolean;
  /** When the next automatic probe fires (epoch ms), or null while online. */
  nextRetryAt: number | null;
}

const PROBE_TIMEOUT_MS = 5_000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

let state: ConnectivityState = { status: 'online', checking: false, nextRetryAt: null };
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

let backoffMs = BACKOFF_START_MS;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probing = false;

function setState(next: Partial<ConnectivityState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function getConnectivity(): ConnectivityState {
  return state;
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called when the connection comes back after an outage. */
export function onReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

/** The live connection state, for components. */
export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(subscribeConnectivity, getConnectivity, getConnectivity);
}

export function isOnline(): boolean {
  return state.status === 'online';
}

/** A request got a real answer from the API (any status), so it is reachable. */
export function reportReachable(): void {
  if (state.status === 'online') return;
  markOnline();
}

/**
 * A request could not reach the API, or it answered with a gateway error. The
 * status is a first guess; the probe that follows settles which one it is.
 */
export function reportUnreachable(status: Exclude<ConnectionStatus, 'online'> = 'offline'): void {
  if (state.status === 'online') {
    log.warn(`lost connection (${status})`);
    setState({ status });
    backoffMs = BACKOFF_START_MS;
    scheduleProbe(backoffMs);
  }
}

/** The banner's Retry button: probe now instead of waiting out the backoff. */
export function retryNow(): void {
  if (state.status === 'online') return;
  void probe();
}

function markOnline() {
  clearProbe();
  backoffMs = BACKOFF_START_MS;
  const wasDown = state.status !== 'online';
  setState({ status: 'online', checking: false, nextRetryAt: null });
  if (wasDown) {
    log.info('connection restored');
    reconnectListeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        log.warn('reconnect listener threw', String(error));
      }
    });
  }
}

function clearProbe() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = null;
}

function scheduleProbe(delay: number) {
  clearProbe();
  setState({ nextRetryAt: Date.now() + delay });
  probeTimer = setTimeout(() => void probe(), delay);
}

/** Resolves true if `url` answered at all within the timeout. */
async function reachable(url: string, ok: (response: Response) => boolean): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    return ok(response);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(): Promise<void> {
  if (probing) return;
  probing = true;
  clearProbe();
  setState({ checking: true, nextRetryAt: null });

  try {
    // /health runs `select 1`, so a 200 means the API and its database are up.
    if (await reachable(`${env.apiUrl}/health`, (response) => response.ok)) {
      markOnline();
      return;
    }

    // Any HTTP answer from Supabase proves the network works. The auth health
    // endpoint needs the apikey header on some setups, so a 401 still counts.
    const networkUp =
      Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false
        ? false
        : await reachable(`${env.supabaseUrl}/auth/v1/health`, () => true);

    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    setState({ status: networkUp ? 'server-down' : 'offline', checking: false });
    scheduleProbe(backoffMs);
  } finally {
    probing = false;
  }
}

// Coming back to the foreground is the likeliest moment for the network to
// have changed (and timers do not run while backgrounded), so check at once
// rather than waiting out whatever backoff was left.
AppState.addEventListener('change', (next) => {
  if (next === 'active' && state.status !== 'online') void probe();
});

// The browser does know when it goes on or offline; use it where available.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('offline', () => reportUnreachable('offline'));
  window.addEventListener('online', () => retryNow());
}
