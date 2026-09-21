/**
 * When the microphone is open to the voice assistant.
 *
 * The room stays connected for the whole cooking session with the mic track
 * muted; this machine is what decides when to unmute it. It is pure - no React,
 * no LiveKit, no clock of its own - so every rule below is a unit test away
 * from being checked, and the component that drives it only has to feed events
 * in and perform the effects that come out.
 *
 * One rule covers both modes: while the window is open and nobody is speaking,
 * it closes after the mode's silence limit. "Quick" is a short limit, which in
 * practice means one request plus a follow-up; "conversation" is a long one
 * that the agent can also end early when the user says they are done.
 */

export type WindowMode = 'quick' | 'conversation';
export type WindowPhase = 'idle' | 'open';

export type WindowEffect =
  | 'unmute'
  | 'mute'
  | 'playOpenChime'
  | 'playCloseTone'
  /** Stop the agent mid-sentence: the user said the wake word over it. */
  | 'interruptAgent';

export type WindowEventType =
  | 'wake'
  | 'tap'
  | 'userSpeechStart'
  | 'userSpeechEnd'
  | 'agentSpeechStart'
  | 'agentSpeechEnd'
  | 'tick'
  /** The agent's endListening tool: the user said "thanks" or similar. */
  | 'endRequested'
  /** Interruption, backgrounding or teardown: close without a sound. */
  | 'reset';

/** Every event carries the time, so the machine never reads a clock itself. */
export interface WindowEvent {
  type: WindowEventType;
  now: number;
}

export interface WindowState {
  phase: WindowPhase;
  userSpeaking: boolean;
  agentSpeaking: boolean;
  /** When an open window closes if nothing happens; null while someone speaks. */
  deadline: number | null;
  lastWakeAt: number | null;
}

export interface WindowStep {
  state: WindowState;
  effects: WindowEffect[];
}

export const QUICK_SILENCE_MS = 8_000;
export const CONVERSATION_SILENCE_MS = 30_000;
/**
 * The detector reports a rising edge, but a drawn-out "Hey CookMaaate" can
 * still cross the threshold twice. Two chimes for one phrase reads as a glitch.
 */
export const WAKE_COOLDOWN_MS = 1_500;

export const INITIAL_WINDOW: WindowState = {
  phase: 'idle',
  userSpeaking: false,
  agentSpeaking: false,
  deadline: null,
  lastWakeAt: null,
};

function silenceLimit(mode: WindowMode): number {
  return mode === 'quick' ? QUICK_SILENCE_MS : CONVERSATION_SILENCE_MS;
}

function withDeadline(state: WindowState, now: number, mode: WindowMode): WindowState {
  if (state.phase !== 'open') return { ...state, deadline: null };
  const quiet = !state.userSpeaking && !state.agentSpeaking;
  return { ...state, deadline: quiet ? now + silenceLimit(mode) : null };
}

function open(state: WindowState, now: number, mode: WindowMode): WindowStep {
  const effects: WindowEffect[] = [];
  if (state.agentSpeaking) effects.push('interruptAgent');
  if (state.phase === 'idle') effects.push('unmute');
  effects.push('playOpenChime');
  // The interrupt is asked for, not confirmed; treating the agent as quiet now
  // starts the clock instead of waiting on an agentSpeechEnd that may be late.
  const next = withDeadline({ ...state, phase: 'open', agentSpeaking: false }, now, mode);
  return { state: next, effects };
}

function close(state: WindowState, tone: boolean): WindowStep {
  if (state.phase === 'idle') return { state, effects: [] };
  return {
    state: { ...state, phase: 'idle', deadline: null },
    effects: tone ? ['mute', 'playCloseTone'] : ['mute'],
  };
}

export function stepWindow(state: WindowState, event: WindowEvent, mode: WindowMode): WindowStep {
  const { now } = event;
  switch (event.type) {
    case 'wake':
      if (state.lastWakeAt !== null && now - state.lastWakeAt < WAKE_COOLDOWN_MS) {
        return { state, effects: [] };
      }
      return open({ ...state, lastWakeAt: now }, now, mode);
    case 'tap':
      // A tap on an open, quiet window is the user closing it by hand; over the
      // agent's voice it is a request to cut it off, same as the wake word.
      if (state.phase === 'open' && !state.agentSpeaking) return close(state, true);
      return open(state, now, mode);
    case 'userSpeechStart':
      return { state: withDeadline({ ...state, userSpeaking: true }, now, mode), effects: [] };
    case 'userSpeechEnd':
      return { state: withDeadline({ ...state, userSpeaking: false }, now, mode), effects: [] };
    case 'agentSpeechStart':
      return { state: withDeadline({ ...state, agentSpeaking: true }, now, mode), effects: [] };
    case 'agentSpeechEnd':
      return { state: withDeadline({ ...state, agentSpeaking: false }, now, mode), effects: [] };
    case 'tick':
      if (state.phase === 'open' && state.deadline !== null && now >= state.deadline) {
        return close(state, true);
      }
      return { state, effects: [] };
    case 'endRequested':
      return close(state, true);
    case 'reset':
      // Keep the speaking flags: they are observations of the room, not
      // window state, and a mid-sentence reset (a detector-effect cleanup or
      // onInterrupted) must not make the machine think the agent went quiet.
      // The next wake still needs to see agentSpeaking so it can interrupt.
      return {
        state: {
          ...INITIAL_WINDOW,
          userSpeaking: state.userSpeaking,
          agentSpeaking: state.agentSpeaking,
        },
        effects: close(state, false).effects,
      };
  }
}
