import { Agent, AgentSession, AgentServer, cli, function_tool, RunContext } from '@livekit/agents';
import { openai } from '@livekit/agents-plugin-openai';

const COOKING_INSTRUCTIONS = `You are CookMate, a friendly voice cooking assistant. You guide users through recipes step by step.

Your capabilities:
- When the user says "next step", "next", or "go forward", call the navigate_next tool
- When the user says "back", "previous", or "go back", call the navigate_back tool  
- When the user says "repeat", "repeat step", or "say that again", call the repeat_step tool
- You can answer cooking questions, give tips, and encourage the user
- Keep responses concise and helpful - this is a hands-free cooking experience

Always be encouraging and supportive. The user is cooking and may have messy hands.`;

const agent = new Agent({
  instructions: COOKING_INSTRUCTIONS,
  llm: openai.LLM({ model: 'gpt-4.1-mini' }),
  stt: openai.STT({ model: 'gpt-4o-transcribe' }),
  tts: openai.TTS({ model: 'gpt-4o-mini-tts', voice: 'alloy' }),
  tools: [
    function_tool('navigate_next', 'Navigate to the next cooking step. Call this when the user wants to move forward.', async (ctx: RunContext) => {
      try {
        await ctx.room.localParticipant?.performRpc({
          destinationIdentity: ctx.room.remoteParticipants.values().next().value?.identity || '',
          method: 'navigate_next',
          payload: '',
        });
        return 'Moved to the next step';
      } catch (e) {
        return 'Failed to navigate to next step';
      }
    }),
    function_tool('navigate_back', 'Navigate to the previous cooking step. Call this when the user wants to go back.', async (ctx: RunContext) => {
      try {
        await ctx.room.localParticipant?.performRpc({
          destinationIdentity: ctx.room.remoteParticipants.values().next().value?.identity || '',
          method: 'navigate_back',
          payload: '',
        });
        return 'Moved to the previous step';
      } catch (e) {
        return 'Failed to navigate to previous step';
      }
    }),
    function_tool('repeat_step', 'Repeat the current cooking step instructions. Call this when the user asks to hear the step again.', async (ctx: RunContext) => {
      try {
        await ctx.room.localParticipant?.performRpc({
          destinationIdentity: ctx.room.remoteParticipants.values().next().value?.identity || '',
          method: 'repeat_step',
          payload: '',
        });
        return 'Repeated the current step';
      } catch (e) {
        return 'Failed to repeat step';
      }
    }),
  ],
});

const server = new AgentServer();

server.rtcSession(async (ctx) => {
  const session = new AgentSession({
    vad: openai.VAD({ model: 'gpt-4o-transcribe' }),
    stt: openai.STT({ model: 'gpt-4o-transcribe' }),
    llm: openai.LLM({ model: 'gpt-4.1-mini' }),
    tts: openai.TTS({ model: 'gpt-4o-mini-tts', voice: 'alloy' }),
  });

  await session.start(agent, ctx.room);
  await session.generateReply({
    instructions: 'Greet the user and ask if they are ready to start cooking.',
  });
});

cli.runApp(server);
