# livekit-token

Mints a short-lived LiveKit access token for the calling user.

The app calls this instead of shipping a token in the bundle. Room name and
participant identity are derived from the **verified Supabase user**, never from
the request body, so users cannot join each other's cooking sessions.

## Contract

```
POST  (Authorization: Bearer <supabase access token>)
body  { "recipeId": "42" }

200   { "token": "...", "serverUrl": "wss://...", "roomName": "cooking-<uid>-42",
        "identity": "user-<uid>", "expiresAt": 1789538963000 }
401   { "error": "Not authenticated" }
400   { "error": "recipeId is required" }
500   { "error": "Voice service is not configured" }
```

Room: `cooking-<user id>-<recipe id>` — stable across reconnects, never shared.
Identity: `user-<user id>`. Token TTL: 2 hours.

## Agent dispatch

The worker runs under an explicit agent name (`cookmate`, see
`agent/src/constants.ts`), so it does **not** auto-join rooms. This function puts
a matching `RoomAgentDispatch` in the token's `roomConfig`. If the name here and
in `constants.ts` ever drift, the room still connects and no agent ever joins -
the app will show "Assistant unavailable".

## Grants

Both of these are required and easy to miss:

- `canPublishData` — the agent drives the app over RPC, which rides the data channel.
- `canUpdateOwnMetadata` — the app publishes the live recipe/step state as
  participant attributes. Without it the agent has no recipe context and cannot
  follow manual step changes.

## Deploy

```bash
supabase link --project-ref <your project ref>
supabase secrets set \
  LIVEKIT_URL=wss://<your-project>.livekit.cloud \
  LIVEKIT_API_KEY=<key> \
  LIVEKIT_API_SECRET=<secret>
supabase functions deploy livekit-token
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected by the platform.

## Local dev

The app has no fallback: this function must be deployed (or served with
`supabase functions serve livekit-token`) before the voice assistant will
connect. Every token is minted per user and per recipe from the caller's
Supabase session. See `lib/livekitToken.ts`.
