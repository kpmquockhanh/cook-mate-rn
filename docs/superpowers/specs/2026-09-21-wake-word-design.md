# Wake word ("Hey CookMate") for the cooking voice assistant

Date: 2026-09-21
Status: Approved. Implementation plan: `docs/superpowers/plans/2026-09-21-wake-word.md`

## Problem

In cooking mode the LiveKit voice session, once started, streams the microphone
to the agent continuously. Two consequences:

1. **False replies.** The agent answers speech that was not meant for it: family
   conversation, the TV, a noisy extractor fan.
2. **Cost and privacy.** Every second of kitchen audio is sent off the device and
   transcribed, whether or not anyone is talking to the assistant.

## Goal

The assistant only hears the user after they say **"Hey CookMate"** (or tap the
mic). Until then the microphone audio never leaves the phone.

## Non-goals

- Wake word outside cooking mode (Home, Search). Possible later; not in scope.
- Wake word while the app is backgrounded or the phone is locked.
- User-chosen or user-recorded wake phrases.
- Web support for the wake word itself. Web falls back to tap-to-talk.

## Decisions

| Topic | Decision |
|---|---|
| Wake phrase | One phrase, "Hey CookMate", for both English and Vietnamese. One model. |
| Detection | On device, openWakeWord, in our own Expo native module. |
| Engine coupling | App code depends only on a `WakeWordDetector` interface, so the engine can be replaced. |
| Room while idle | Stays connected, mic track published but **muted**. Unmuted when the window opens. |
| Always-listening mode | Removed. The wake word is the only hands-free entry point. Tapping the mic opens the same window as the wake word. |
| Window length | User setting: **quick** (default) or **conversation**. |
| Feedback | Open chime + close tone, plus the header icon and status banner. |
| Wake word while the agent speaks | Interrupts the agent and opens a fresh window (barge-in). |

## Behaviour

### Listening window modes (setting `voiceWakeWindow`)

- **quick** (default): the window stays open for one request plus follow-ups. It
  closes **8 s after the agent finishes speaking** if the user has not started
  speaking again.
- **conversation**: the window closes after **30 s with no user or agent speech**,
  or when the user ends it verbally ("thanks", "cảm ơn", "that's all"). The agent
  recognizes this through its `endListening` tool and asks the app to close.

The two durations are constants in `lib/listeningWindow.ts`, not user settings.

### Existing settings

- `voiceEnabled` is unchanged: off means no token and no session.
- `voiceAutoStart` now means "connect the room and start waiting for the wake word on
  entering cooking mode". Without it the user taps the mic once to connect, and
  the window opens immediately.

## Architecture

### App

1. **`modules/wake-word/`**: a local Expo native module (Swift + Kotlin).
   - Runs the openWakeWord pipeline (melspectrogram → embedding → `hey_cookmate`
     classifier) with ONNX Runtime, using models bundled in the module.
   - API: `start(threshold: number)`, `stop()`, `setThreshold(n)`.
   - Events: `onWakeWord({ score })`, `onInterrupted()`, `onResumed()`,
     `onError({ message })`.
   - Knows nothing about LiveKit, settings or UI.
2. **`lib/wakeWord/WakeWordDetector.ts`**: the interface
   (`isAvailable`, `start`, `stop`, `setThreshold`, `onDetected`, `onInterrupted`,
   `onResumed`, `onError`), with two adapters:
   - `openWakeWordDetector.ts` wraps the native module.
   - `unavailableDetector.ts` is a no-op (`isAvailable = false`). It is used on web and
     when the native module or its models fail to load.
3. **`lib/listeningWindow.ts`**: a pure state machine with no React and no native imports.
   - States: `idle` | `open`.
   - Events: `wake`, `tap`, `userSpeechStart`, `userSpeechEnd`,
     `agentSpeechStart`, `agentSpeechEnd`, `tick(now)`, `endRequested`, `reset`.
   - Config: `mode: 'quick' | 'conversation'`.
   - Output: the next state plus effects (`unmute`, `mute`, `playOpenChime`,
     `playCloseTone`, `interruptAgent`). The caller performs the effects.
4. **`components/LiveKitVoice.tsx`** (and the `.web.tsx` counterpart, which gets tap-only):
   - Publishes the mic track muted and drives `setMicrophoneEnabled` from the
     machine's effects.
   - Maps `useVoiceAssistant` state and local speaking state onto machine events.
   - Starts and stops the detector with the room. Raises the threshold
     (0.5 → 0.8) while the agent is speaking.
   - Registers an RPC method `close_listening` (agent → app), which sends `endRequested`.
   - Calls the RPC `interrupt` on the agent when a barge-in effect is emitted.
   - Plays the chimes (bundled short audio assets).
5. **`lib/voiceSession.ts`**: new status `waiting-for-wake-word` (icon
   `mic-outline`) and `wake-word-unavailable` (icon `mic-outline`, warn tone,
   action "tap the mic to talk"). `listening` now means "window open".
   Copy is added to `lib/i18n/en.ts` and `lib/i18n/vi.ts`.
6. **`lib/SettingsContext.tsx`**:
   - Add `voiceWakeWindow: 'quick' | 'conversation'` (default `'quick'`).
   - No schema bump: the field is additive, and `sanitize` already fills missing
     fields from the defaults, so a v1 blob reads as `'quick'`. `sanitize` rejects
     unknown values. The schema moves to a pure `lib/settingsSchema.ts` so it can
     be unit tested.
   - A `SegmentedRow` in the Voice section of `app/(tabs)/settings.tsx`, in both languages.

### Agent (`agent/src/agent.ts`)

7. Register the RPC method **`interrupt`** (app → agent), which calls `session.interrupt()`.
8. Add the LLM tool **`endListening`**: "Call when the user indicates they are
   done talking for now (e.g. thanks, that's all, cảm ơn)". It calls
   `performRpc('close_listening')` on the app participant. Harmless in quick mode.
9. Instructions: the agent must never say the name "CookMate", so its own
   speech cannot wake the detector.

### Model training (`tools/wakeword/`)

- A script or notebook that generates synthetic "Hey CookMate" clips with
  English- and Vietnamese-accented TTS voices and augments them with kitchen
  noise and room reverb. It trains the openWakeWord classifier and exports ONNX.
- An evaluation script that reports the false-reject rate and false accepts per hour.
- A README recording the steps, the data sources, and the chosen threshold.
- The exported model is committed into `modules/wake-word/` assets.

## Data flow

1. Cooking screen mounts → room connects → mic track published muted →
   detector starts → status `waiting-for-wake-word`.
2. `onDetected` or a mic tap → `wake`/`tap` → effects `unmute`, `playOpenChime` →
   status `listening`.
3. The agent handles the turn with its existing VAD and turn detection and replies.
4. The window closes by mode rule → effects `mute`, `playCloseTone` → status
   `waiting-for-wake-word`.
5. Wake word while the agent is speaking → effects `interruptAgent`,
   `playOpenChime` (and `unmute` if idle). The window timer restarts.
6. Cooking screen unmounts → detector stops, room disconnects. App goes to the
   background → detector stops and the window closes (mute, no tone); the room
   stays connected, as it does today. On return to the foreground the detector
   restarts.

The detector runs for the whole connected session, including while the window is open.

## Error handling

| Situation | Behaviour |
|---|---|
| Native module or model fails to load; web | `unavailableDetector`; status `wake-word-unavailable`; mic tap still opens the window. |
| Mic permission denied | Existing `mic-denied` status, unchanged. |
| Audio session interrupted (call, Siri, alarm) | `onInterrupted` → close any open window (mute, no tone), pause. `onResumed` → restart detector. |
| Detector `onError` at runtime | Log it, switch to `wake-word-unavailable`, keep the session alive. Never crash. |
| Wake detected with status `no-agent` | No chime and the window does not open. The existing `no-agent` status stays visible. |
| Repeated detections | A 1.5 s cooldown after each detection. |
| False wake | Closes on its own after the quick/conversation timeout. Detection scores (never audio) are logged for threshold tuning. |

## Testing

- **Unit tests (`node:test` via `tsx --test`, the runner `backend/` already uses):**
  - `listeningWindow`: every transition and timeout in both modes, barge-in,
    `endRequested`, cooldown, `reset`.
  - `settingsSchema` migrate/sanitize: v1 blob gets the default, unknown value rejected.
- **Model evaluation (script, not CI):** on held-out clips, ≥ 90 % detection at
  1 m and ≥ 80 % at 3 m, across English- and Vietnamese-accented speakers. ≤ 1 false
  wake per hour on kitchen noise, TV, and English/Vietnamese chatter.
- **On-device checks (iOS and Android):** detection while the room is connected;
  barge-in; no self-wake on speakerphone; phone-call interruption;
  background/foreground; both window modes; tap fallback with the detector disabled.

## Step zero: mic-sharing spike (before building the module)

A throwaway check that a native openWakeWord capture and LiveKit's WebRTC capture
can run together on iOS and Android, with detection working and WebRTC echo
cancellation intact.

- **If it passes:** proceed as designed. The module opens its own capture in
  the shared audio session.
- **If it fails:** the module must instead consume audio frames from WebRTC's audio
  device module. That is a larger native task, and this spec gets revised before
  implementation.

## Open risks

- Wake-word accuracy for Vietnamese-accented speakers depends on the synthetic
  training data. The evaluation step is where this shows up. We may need a few real
  recordings.
- The iOS audio session category and mode chosen by LiveKit (`AudioSession`) must
  stay compatible with the detector. The spike covers this.
