import { config } from 'dotenv';
config();

import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk';
import { AGENT_NAME } from './constants.js';

// Dev convenience only: prints a long-lived token for a single shared room.
// Real sessions get a per-user token from the `livekit-token` Supabase edge
// function (see supabase/functions/livekit-token/index.ts).

const apiKey = process.env.LIVEKIT_API_KEY!;
const apiSecret = process.env.LIVEKIT_API_SECRET!;

if (!apiKey || !apiSecret) {
  console.error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in .env');
  process.exit(1);
}

const token = new AccessToken(apiKey, apiSecret, {
  identity: 'cookmate-user',
  name: 'CookMate User',
});

token.addGrant({
  roomJoin: true,
  room: 'cooking-room',
  canPublish: true,
  canSubscribe: true,
  // The agent drives the app over RPC, which rides the data channel.
  canPublishData: true,
  // Required for localParticipant.setAttributes(), which is how the app tells
  // the agent which recipe and step the user is on. Without it the agent runs
  // blind.
  canUpdateOwnMetadata: true,
});

// The worker uses explicit dispatch, so the token has to ask for it by name.
token.roomConfig = new RoomConfiguration({
  agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
});

const jwt = await token.toJwt();
console.log(jwt);
