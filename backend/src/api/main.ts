import { close } from '../db.js';
import { env } from '../env.js';
import { logger } from '../log.js';
import { buildServer } from './server.js';

const log = logger('api');

const app = await buildServer();
await app.listen({ port: env.apiPort, host: env.apiHost });
log.info(`listening on http://${env.apiHost}:${env.apiPort}`);

// Unlike the review UI (localhost-only by design), this binds 0.0.0.0 by
// default: a phone running the Expo app has to reach it across the LAN.
async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, shutting down`);
  await app.close();
  await close();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
