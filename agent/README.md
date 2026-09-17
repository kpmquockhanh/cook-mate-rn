# CookMate voice agent

The LiveKit worker behind the hands-free cooking screen. The app mints a token,
joins a room, and this worker is dispatched into it by name; it then listens,
answers cooking questions, and drives the screen over RPC.

Nothing in the app can substitute for it: with the worker down the room still
connects, the microphone still opens, and the user simply talks to nobody. The
cooking screen detects that after ten seconds and says "No assistant answered —
use the buttons below", so a silent assistant almost always means this process
is not running.

## Install

```sh
cd agent
npm install --ignore-scripts
```

`--ignore-scripts` is not optional today. A plain `npm install` fails in
`sharp`'s install script - a transitive dependency of `@livekit/agents` - which
runs before npm has finished placing the prebuilt `@img/sharp-darwin-arm64`
binary next to it, so it tries to compile libvips from source and stops with
"Please add node-addon-api to your dependencies". Skipping install scripts lets
the prebuilt binary land, and nothing this worker needs depends on one running.

## Configure

```sh
cp .env.example .env   # then fill in LIVEKIT_URL / API key / API secret
```

STT, LLM, TTS and VAD all run through LiveKit Inference, so those keys are the
only credentials required.

## Run

```sh
npm run dev     # watch mode
npm run start   # production mode
```

A healthy start logs `registered worker` with `agentName: "cookmate"`. That name
has to match the agent dispatch in every token issuer - see
`src/constants.ts` - or the worker registers happily and is never dispatched
into a room.

## Checking the whole chain

When voice does not work, the failure is in one of four places, and the app's
status line names which:

| What the cooking screen shows | Where the problem is |
| --- | --- |
| "Voice assistant unavailable — …" | the `livekit-token` edge function; the text is its own error |
| "Microphone is off — …" | OS or browser permission |
| "No assistant answered — …" | this worker: not running, or its name does not match the dispatch |
| "Listening — …" | the chain is up |

Every one of these is also written to the console with a `[voice]` or
`[livekit-token]` prefix, with the underlying error attached.
