/**
 * Mints a short-lived LiveKit access token for the calling user.
 *
 * The room name and participant identity are derived from the *verified*
 * Supabase user, never from the request body, so a caller cannot join another
 * user's cooking session by asking for it.
 *
 * Deploy:
 *   supabase secrets set LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=...
 *   supabase functions deploy livekit-token
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'npm:livekit-server-sdk@2';

const LIVEKIT_URL = Deno.env.get('LIVEKIT_URL') ?? '';
const LIVEKIT_API_KEY = Deno.env.get('LIVEKIT_API_KEY') ?? '';
const LIVEKIT_API_SECRET = Deno.env.get('LIVEKIT_API_SECRET') ?? '';

/** Cooking sessions run long; keep it bounded but not annoying. */
const TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Must match AGENT_NAME in agent/src/constants.ts. The worker uses explicit
 * dispatch, so without this the room connects and no agent ever joins.
 */
const AGENT_NAME = 'cookmate';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/** Keep identifiers to characters LiveKit and our logs handle predictably. */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.error('livekit-token: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured');
    return json({ error: 'Voice service is not configured' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  // Resolve the caller against their own JWT rather than trusting the body.
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return json({ error: 'Not authenticated' }, 401);
  }

  let recipeId = '';
  try {
    const body = await req.json();
    recipeId = String(body?.recipeId ?? '');
  } catch {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  if (!recipeId) {
    return json({ error: 'recipeId is required' }, 400);
  }

  // One room per user per recipe: stable across reconnects, and never shared
  // between users.
  const roomName = `cooking-${slug(user.id)}-${slug(recipeId)}`;
  const identity = `user-${slug(user.id)}`;

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: user.email ?? 'CookMate User',
    ttl: TOKEN_TTL_SECONDS,
  });

  at.addGrant({
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
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
  });

  return json({
    token: await at.toJwt(),
    serverUrl: LIVEKIT_URL,
    roomName,
    identity,
    expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000,
  });
});
