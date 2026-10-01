/**
 * What a connectivity probe found, as a status. Kept free of react-native so it
 * runs under `node:test`; lib/connectivity.ts does the fetching.
 *
 * Any HTTP answer proves the network works, so only "no answer at all" from
 * both the API and the storage host reads as offline. When both live on one
 * machine and that machine is down, this still says offline: telling the two
 * apart would take a probe of a host outside our own infrastructure.
 */
export type ProbeAnswer = 'ok' | 'error' | 'no-answer';

export function classifyProbe(result: {
  /** /health: 'ok' for a 2xx, 'error' for any other HTTP status. */
  health: ProbeAnswer;
  /** Whether the storage host gave any HTTP answer. */
  storage: 'answered' | 'no-answer';
  /** The browser's own navigator.onLine === false (web only). */
  browserOffline: boolean;
}): 'online' | 'offline' | 'server-down' {
  if (result.health === 'ok') return 'online';
  if (result.health === 'error') return 'server-down';
  if (result.browserOffline) return 'offline';
  return result.storage === 'answered' ? 'server-down' : 'offline';
}
