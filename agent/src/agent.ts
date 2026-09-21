import 'dotenv/config';

import {
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
  inference,
} from '@livekit/agents';
import { RoomEvent, type Participant } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { AGENT_NAME } from './constants.js';
import { TTS as OmniVoiceTTS } from './omnivoice-tts.js';
import {
  LANGUAGE,
  LANGUAGE_NAME,
  TURN_DETECTION,
  endpointingOptions,
  interruptionOptions,
  noiseCancellation,
  numberEnv,
  optionalEnv,
  vadOptions,
} from './speech-config.js';
import {
  COOKING_STATE_ATTRIBUTE,
  buildInstructions,
  parseCookingState,
  type CookingState,
} from './cooking-context.js';

/** How long to wait for the app's first state publish before greeting anyway. */
const CONTEXT_WAIT_MS = 2000;

/**
 * Speech comes from a self-hosted omnivoice-server when `OMNIVOICE_URL` names
 * one, and from LiveKit Inference otherwise. Keeping the fallback means an
 * environment that has only the LiveKit credentials still talks - the worker
 * does not need a second service just to say hello.
 */
function buildTTS() {
  const baseURL = optionalEnv('OMNIVOICE_URL');
  if (!baseURL) {
    // Inworld is the default because it is the one LiveKit Inference TTS that
    // covers Vietnamese. Cartesia's sonic-3 - the previous default - speaks 40+
    // languages but not this one, so it was reading Vietnamese text with English
    // phonetics. Override the trio below to use any other provider.
    const model = optionalEnv('TTS_MODEL') ?? 'inworld/inworld-tts-2';
    const voice = optionalEnv('TTS_VOICE') ?? 'Ashley';
    const language = optionalEnv('TTS_LANGUAGE') ?? LANGUAGE;
    console.log(`[cookmate] TTS: LiveKit Inference ${model} (voice "${voice}", language ${language})`);
    return new inference.TTS({ model, voice, language });
  }

  const instructions = optionalEnv('OMNIVOICE_INSTRUCTIONS');

  // Synthesis is roughly half of real time on CPU, so the diffusion step count
  // is the one knob that decides whether replies arrive late. Lower it there.
  const rawNumStep = optionalEnv('OMNIVOICE_NUM_STEP');
  const numStep = rawNumStep === undefined ? undefined : Number(rawNumStep);
  if (numStep !== undefined && !Number.isFinite(numStep)) {
    console.warn(`[cookmate] Ignoring OMNIVOICE_NUM_STEP: "${rawNumStep}" is not a number`);
  }

  console.log(
    `[cookmate] TTS: omnivoice-server at ${baseURL} ` +
      `(${instructions ? `instructions "${instructions}"` : `voice "${optionalEnv('OMNIVOICE_VOICE') ?? 'fable'}"`})`
  );
  return new OmniVoiceTTS({
    baseURL,
    apiKey: optionalEnv('OMNIVOICE_API_KEY'),
    // `instructions` is the server's strongest control and overrides the preset
    // in `voice`, so only one of the two is ever sent.
    ...(instructions ? { instructions } : { voice: optionalEnv('OMNIVOICE_VOICE') ?? 'fable' }),
    ...(numStep !== undefined && Number.isFinite(numStep) ? { numStep } : {}),
  });
}

/**
 * Invoke an RPC method on the app and hand its result back to the LLM. The app
 * returns the text of the step it is now showing, which is what lets the agent
 * read the step aloud.
 */
async function callApp(
  ctx: JobContext,
  identity: string | undefined,
  method: string,
  failureMessage: string
): Promise<string> {
  if (!identity) {
    console.error(`[cookmate] RPC ${method} skipped: no app participant in the room`);
    return failureMessage;
  }

  try {
    const result = await ctx.room.localParticipant?.performRpc({
      destinationIdentity: identity,
      method,
      payload: '',
    });
    return result || failureMessage;
  } catch (err) {
    console.error(`[cookmate] RPC ${method} to ${identity} failed:`, err);
    return failureMessage;
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Accepting the job only hands us the room's credentials; it does not join.
    // Everything below needs a live room - `session.start` publishes the agent's
    // track and `waitForParticipant` throws "room is not connected" - so connect
    // before any of it.
    await ctx.connect();

    // The app participant this job is serving. Pinned once it joins rather than
    // picking whichever participant happens to be first in the map, so the
    // agent cannot end up driving someone else's screen.
    let appIdentity: string | undefined;

    const resolveAppIdentity = (): string | undefined => {
      if (appIdentity && ctx.room.remoteParticipants.has(appIdentity)) {
        return appIdentity;
      }
      // The pinned participant is gone - it may have reconnected under a new
      // identity, so fall back to whoever is present and re-pin.
      appIdentity = [...ctx.room.remoteParticipants.values()][0]?.identity;
      return appIdentity;
    };

    const notifyApp = (method: string, failureMessage: string) =>
      callApp(ctx, resolveAppIdentity(), method, failureMessage);

    const agent = new voice.Agent({
      instructions: buildInstructions(null),
      tools: {
        navigateNext: llm.tool({
          description:
            'Navigate to the next cooking step. Call this when the user wants to move forward. Returns the text of the step now shown.',
          execute: async () =>
            notifyApp('navigate_next', 'Failed to navigate to next step'),
        }),
        navigateBack: llm.tool({
          description:
            'Navigate to the previous cooking step. Call this when the user wants to go back. Returns the text of the step now shown.',
          execute: async () =>
            notifyApp('navigate_back', 'Failed to navigate to previous step'),
        }),
        repeatStep: llm.tool({
          description:
            'Get the current cooking step instructions. Call this when the user asks to hear the step again. Returns the text of the step now shown.',
          execute: async () => notifyApp('repeat_step', 'Failed to repeat step'),
        }),
        endListening: llm.tool({
          description:
            'Close the microphone on the app. Call this when the user says they are done for now (thanks, that is all, cảm ơn). Harmless if it is already closed.',
          execute: async () => notifyApp('close_listening', 'The microphone could not be closed'),
        }),
      },
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: optionalEnv('STT_MODEL') ?? 'deepgram/nova-3',
        language: optionalEnv('STT_LANGUAGE') ?? LANGUAGE,
      }),
      llm: new inference.LLM({ model: optionalEnv('LLM_MODEL') ?? 'google/gemini-2.5-flash' }),
      tts: buildTTS(),
      vad: new inference.VAD(vadOptions),
      // Turn taking, i.e. the fix for the agent answering four times while the
      // user was still speaking one sentence. See `speech-config.ts` for what
      // each group does and why the defaults there are looser than stock.
      turnHandling: {
        turnDetection: TURN_DETECTION,
        endpointing: endpointingOptions,
        interruption: interruptionOptions,
        // Preemptive generation starts an LLM call on the *interim* transcript
        // and throws it away if the user keeps talking. With a jumpy VAD that is
        // several concurrent generations per utterance - exactly the pile-up in
        // the logs - and the wasted calls are billed. Off unless asked for.
        preemptiveGeneration: { enabled: optionalEnv('PREEMPTIVE_GENERATION') === 'true' },
      },
      // Suppress interruptions for the first few seconds of each agent turn,
      // while the browser's echo canceller is still adapting to the new voice.
      // This is when self-echo is loudest and most likely to be mistaken for
      // the user barging in.
      aecWarmupDuration: numberEnv('AEC_WARMUP_MS', 3000),
    });

    // Cloud-only, so opt-in; strips kitchen noise and other voices before the
    // VAD ever sees them.
    const nc = noiseCancellation();

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: nc ? { noiseCancellation: nc } : undefined,
    });

    // The app calls this when the user says the wake word over the agent: stop
    // talking now, the user has something to say.
    ctx.room.localParticipant?.registerRpcMethod('interrupt', async () => {
      console.info('[cookmate] RPC interrupt');
      void session.interrupt();
      return 'ok';
    });

    // Resolves as soon as the app publishes its first state, so the greeting can
    // name the recipe instead of asking a question the app already answered.
    let onFirstState: ((state: CookingState) => void) | undefined;
    const firstState = new Promise<CookingState>((resolve) => {
      onFirstState = resolve;
    });

    const applyCookingState = async (raw: string | undefined): Promise<CookingState | null> => {
      const next = parseCookingState(raw);
      if (!next) return null;
      await agent.updateInstructions(buildInstructions(next));
      onFirstState?.(next);
      return next;
    };

    // The app may set the attribute before or after the agent joins, so read
    // whatever is already there and then follow every change.
    ctx.room.on(
      RoomEvent.ParticipantAttributesChanged,
      (changed: Record<string, string>, participant: Participant) => {
        if (participant.identity !== resolveAppIdentity()) return;
        if (!(COOKING_STATE_ATTRIBUTE in changed)) return;
        void applyCookingState(changed[COOKING_STATE_ATTRIBUTE]);
      }
    );

    const participant = await ctx.waitForParticipant();
    appIdentity = participant.identity;
    await applyCookingState(participant.attributes[COOKING_STATE_ATTRIBUTE]);

    // The app publishes its state just after connecting, which can land either
    // side of the agent joining. Wait briefly rather than greeting blind, but do
    // not hold up the session if nothing arrives.
    let contextTimer: NodeJS.Timeout | undefined;
    const initialState = await Promise.race([
      firstState,
      new Promise<null>((resolve) => {
        contextTimer = setTimeout(() => resolve(null), CONTEXT_WAIT_MS);
      }),
    ]);
    clearTimeout(contextTimer);

    await session.generateReply({
      instructions:
        (initialState
          ? `Greet the user and mention that you will be helping them cook ${initialState.title}. Do not ask a question.`
          : 'Greet the user and say you can help them cook. Do not ask a question.') +
        ` Speak in ${LANGUAGE_NAME}. Keep it to one or two short sentences.`,
    });
  },
});

// `npm run start` runs the worker in production mode, where @livekit/agents
// defaults its health-check server to port 8081 - the same default port Expo
// Metro uses. Pin it elsewhere so `agent` and `npm run web`/`expo start` can
// run side by side without one stealing the other's port.
const AGENT_HEALTH_PORT = Number(process.env.AGENT_PORT) || 8082;

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    port: AGENT_HEALTH_PORT,
  })
);
