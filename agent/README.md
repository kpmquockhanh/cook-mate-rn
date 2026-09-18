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

STT, LLM and VAD all run through LiveKit Inference, so those keys are the only
credentials required. TTS can come from there too, or from a local
omnivoice-server - see below.

## Language

The agent listens, thinks and speaks in Vietnamese by default. One setting moves
all three:

```sh
AGENT_LANGUAGE=vi   # two-letter code; drives STT, TTS and the system prompt
```

Each leg can still be overridden on its own:

| Setting        | Default                 | Notes                                             |
| -------------- | ----------------------- | ------------------------------------------------- |
| `STT_MODEL`    | `deepgram/nova-3`       | nova-3 covers Vietnamese via its multilingual head |
| `STT_LANGUAGE` | `AGENT_LANGUAGE`        |                                                    |
| `LLM_MODEL`    | `google/gemini-2.5-flash` |                                                  |
| `TTS_MODEL`    | `inworld/inworld-tts-2` | the LiveKit Inference TTS that speaks Vietnamese   |
| `TTS_VOICE`    | `Ashley`                |                                                    |
| `TTS_LANGUAGE` | `AGENT_LANGUAGE`        |                                                    |

Cartesia's `sonic-3` was the previous TTS default. It covers 40+ languages but
not Vietnamese, so it read Vietnamese text with English phonetics - that is why
the default moved to Inworld.

One thing the language setting cannot fix: LiveKit's semantic turn detector
(`turn-detector-v1`) has no Vietnamese model. For any language it does not know,
the agent pins turn detection to plain VAD instead of asking a model that has no
opinion - set `TURN_DETECTION` explicitly to override.

## Turn taking

Symptoms this section is for: the agent replying several times to one sentence,
cutting its own answer off, or logging a stream of `START_OF_SPEECH` /
`END_OF_SPEECH` with an empty `audioTranscript`. All of those are the same
problem - something other than the user is opening a turn.

Usually it is the agent's own voice coming back through the speaker. Fix that
first at the source: both app builds now request `echoCancellation`,
`noiseSuppression` and `autoGainControl` on the microphone. Headphones settle it
outright.

The worker-side defaults are deliberately less twitchy than the library's:

| Setting                        | Default | What it does                                            |
| ------------------------------ | ------- | ------------------------------------------------------- |
| `VAD_MIN_SPEECH_MS`            | `120`   | discard blips shorter than a syllable                     |
| `VAD_MIN_SILENCE_MS`           | `700`   | the real debounce - a mid-sentence pause no longer splits the utterance |
| `VAD_PREFIX_PADDING_MS`        | `300`   | pre-roll kept ahead of speech start                       |
| `VAD_ACTIVATION_THRESHOLD`     | `0.6`   | raise to ignore steadier background noise                 |
| `ENDPOINTING_MIN_DELAY_MS`     | `600`   | extra grace after the VAD goes quiet (additive with it)   |
| `ENDPOINTING_MAX_DELAY_MS`     | `4000`  | hard cap on that wait                                     |
| `INTERRUPTION_MIN_DURATION_MS` | `700`   | speech this short never interrupts the agent              |
| `INTERRUPTION_MIN_WORDS`       | `2`     | **and** it has to transcribe to real words - this is what stops echo from cutting replies short |
| `AEC_WARMUP_MS`                | `3000`  | ignore interruptions while the echo canceller adapts      |
| `PREEMPTIVE_GENERATION`        | off     | `true` re-enables speculative LLM calls on interim transcripts |
| `LIVEKIT_NOISE_CANCELLATION`   | off     | LiveKit Cloud only; `bvc` also removes other people's voices |

Rule of thumb when the agent still interrupts itself: raise
`VAD_ACTIVATION_THRESHOLD` and `INTERRUPTION_MIN_WORDS`. When it answers before
the user has finished a thought: raise `VAD_MIN_SILENCE_MS`. When it feels
sluggish: lower `ENDPOINTING_MIN_DELAY_MS` first, the VAD silence second.

## Speech (TTS)

Set `OMNIVOICE_URL` and the worker speaks through a self-hosted
[omnivoice-server](https://github.com/maemreyo/omnivoice-server); leave it unset
and it falls back to LiveKit Inference (Inworld by default - see **Language**).
Nothing else changes either way.

```sh
# in .env - every line below except the URL is optional, and an optional
# setting you do not want should be left out entirely rather than left blank.
OMNIVOICE_URL=http://127.0.0.1:8880

# An OpenAI-style preset name: alloy, fable, onyx, nova, ...
OMNIVOICE_VOICE=fable

# Voice design attributes. Overrides OMNIVOICE_VOICE when set.
# OMNIVOICE_INSTRUCTIONS=female,middle-aged,moderate pitch,american accent

# Diffusion steps; the server default is 32. Fewer is faster and rougher.
# OMNIVOICE_NUM_STEP=16

# Only if the server was started with an API key.
# OMNIVOICE_API_KEY=
```

Keep those comments on their own lines. Docker Compose's `env_file` parser only
strips an inline `#` comment when the line already has a value: `KEY=fable  # x`
gives `fable`, but `KEY=  # x` gives `# x`. A blank-with-a-comment therefore
reaches the worker as a real setting, and the server answers a bad voice
attribute with a 422 - which is not retryable, so it closes the session. The
worker now drops such values with a warning rather than sending them, but the
tidier fix is not to write them.

`OMNIVOICE_INSTRUCTIONS` is the server's voice *design* control and takes
precedence over a preset, so the worker sends one or the other, never both.
Its vocabulary is comma-separated attributes, e.g.
`female,middle-aged,moderate pitch,american accent`.

Check the server is up and holding the model before blaming the worker:

```sh
curl -s http://127.0.0.1:8880/health   # wants "ready":true and "model_loaded":true
```

The adapter lives in `src/omnivoice-tts.ts`. omnivoice-server has no
push-text socket - each synthesis is one HTTP request for one finished piece of
text - so it declares itself non-streaming and LiveKit wraps it in a
`tts.StreamAdapter`, which splits the LLM's token stream into sentences and
calls it once per sentence. Synthesis is roughly half of real time on CPU, so on
a CPU-only host expect the first words of a reply about a second after the LLM
finishes; `OMNIVOICE_NUM_STEP` (the server default is 32) is the knob that
trades quality for that latency.

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

"Listening" with an agent that answers in text but never in audio is the one
case the status line cannot name: that is TTS. With `OMNIVOICE_URL` set, the
worker logs `omnivoice-server returned …` or `failed to reach omnivoice-server
at …` when its speech backend is the problem.

Every one of these is also written to the console with a `[voice]` or
`[livekit-token]` prefix, with the underlying error attached.
