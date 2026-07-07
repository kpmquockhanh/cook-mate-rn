import 'dotenv/config';

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  voice,
  inference,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const COOKING_INSTRUCTIONS = `You are CookMate, a friendly voice cooking assistant. You guide users through recipes step by step.

Your capabilities:
- When the user says "next step", "next", or "go forward", call the navigate_next tool
- When the user says "back", "previous", or "go back", call the navigate_back tool  
- When the user says "repeat", "repeat step", or "say that again", call the repeat_step tool
- You can answer cooking questions, give tips, and encourage the user
- Keep responses concise and helpful - this is a hands-free cooking experience

Always be encouraging and supportive. The user is cooking and may have messy hands.`;

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions: COOKING_INSTRUCTIONS,
      tools: {
        navigateNext: llm.tool({
          description: 'Navigate to the next cooking step. Call this when the user wants to move forward.',
          execute: async () => {
            const participants = [...ctx.room.remoteParticipants.values()];
            const identity = participants[0]?.identity ?? '';
            try {
              await ctx.room.localParticipant?.performRpc({
                destinationIdentity: identity,
                method: 'navigate_next',
                payload: '',
              });
              return 'Moved to the next step';
            } catch {
              return 'Failed to navigate to next step';
            }
          },
        }),
        navigateBack: llm.tool({
          description: 'Navigate to the previous cooking step. Call this when the user wants to go back.',
          execute: async () => {
            const participants = [...ctx.room.remoteParticipants.values()];
            const identity = participants[0]?.identity ?? '';
            try {
              await ctx.room.localParticipant?.performRpc({
                destinationIdentity: identity,
                method: 'navigate_back',
                payload: '',
              });
              return 'Moved to the previous step';
            } catch {
              return 'Failed to navigate to previous step';
            }
          },
        }),
        repeatStep: llm.tool({
          description: 'Repeat the current cooking step instructions. Call this when the user asks to hear the step again.',
          execute: async () => {
            const participants = [...ctx.room.remoteParticipants.values()];
            const identity = participants[0]?.identity ?? '';
            try {
              await ctx.room.localParticipant?.performRpc({
                destinationIdentity: identity,
                method: 'repeat_step',
                payload: '',
              });
              return 'Repeated the current step';
            } catch {
              return 'Failed to repeat step';
            }
          },
        }),
      },
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'en' }),
      llm: new inference.LLM({ model: 'google/gemini-2.5-flash' }),
      tts: new inference.TTS({ model: 'cartesia/sonic-3', voice: '79a125e8-cd45-4c13-8a67-188112f4dd22' }),
      vad: new inference.VAD(),
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    await session.generateReply({
      instructions: 'Greet the user and ask if they are ready to start cooking.',
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
