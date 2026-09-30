import type { FastifyInstance } from 'fastify';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { z } from 'zod';
import { env } from '../../env.js';
import { logger } from '../../log.js';
import { requireUser } from '../auth.js';

const log = logger('voice');

/** Cooking sessions run long; keep it bounded but not annoying. */
export const TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Must match AGENT_NAME in agent/src/constants.ts. The worker uses explicit
 * dispatch, so without this the room connects and no agent ever joins. The
 * packages build separately, so this is duplicated on purpose - change both.
 */
export const AGENT_NAME = 'cookmate';

/** Keep identifiers to characters LiveKit and our logs handle predictably. */
export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

// Route params reach the app as strings, but a numeric id is just as valid.
const TokenBody = z.object({
  recipeId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().trim().min(1)),
});

/**
 * Mints a short-lived LiveKit token for the calling user. The room name and
 * participant identity come from the *verified* user, never from the request
 * body, so a caller cannot join another user's cooking session by asking for it.
 */
export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/voice/token', async (request, reply) => {
    const body = TokenBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'recipeId is required' });

    if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
      log.error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured');
      return reply.code(500).send({ error: 'Voice service is not configured' });
    }

    const user = requireUser(request);
    // One room per user per recipe: stable across reconnects, never shared.
    const roomName = `cooking-${slug(user.id)}-${slug(body.data.recipeId)}`;
    const identity = `user-${slug(user.id)}`;

    const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
      identity,
      name: user.name ?? user.email ?? 'CookMate User',
      ttl: TOKEN_TTL_SECONDS,
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      // The agent drives the app over RPC, which rides the data channel.
      canPublishData: true,
      // The app publishes the live recipe/step state as participant attributes.
      canUpdateOwnMetadata: true,
    });
    // Ask for our named worker; it does not auto-join rooms.
    token.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
    });

    return {
      data: {
        token: await token.toJwt(),
        serverUrl: env.livekitUrl,
        roomName,
        identity,
        expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
      },
    };
  });
}
