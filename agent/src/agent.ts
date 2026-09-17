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
import {
  COOKING_STATE_ATTRIBUTE,
  buildInstructions,
  parseCookingState,
  type CookingState,
} from './cooking-context.js';

/** How long to wait for the app's first state publish before greeting anyway. */
const CONTEXT_WAIT_MS = 2000;

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
      },
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '79a125e8-cd45-4c13-8a67-188112f4dd22',
      }),
      vad: new inference.VAD(),
    });

    await session.start({
      agent,
      room: ctx.room,
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
      instructions: initialState
        ? `Greet the user, mention that you will be helping them cook ${initialState.title}, and ask if they are ready to start.`
        : 'Greet the user and ask if they are ready to start cooking.',
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
