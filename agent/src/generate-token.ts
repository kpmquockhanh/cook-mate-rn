import { config } from 'dotenv';
config();

import { AccessToken } from 'livekit-server-sdk';

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
});

const jwt = await token.toJwt();
console.log(jwt);
