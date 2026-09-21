/**
 * The one vocabulary for the voice assistant's state.
 *
 * Three places need to agree on it: the native and web LiveKitVoice components
 * that produce it, and the cooking screen that turns it into something the user
 * can read. Before this existed the screen inferred readiness from a pair of
 * booleans and could only say "listening" or nothing at all, so the common
 * failures - no credentials, no worker in the room, microphone denied - all
 * looked identical to a session that was simply still starting up.
 */

import type { Translator, TranslationKey } from './i18n';

/** Statuses the LiveKitVoice component itself reports. */
export type VoiceSessionStatus =
  /** Credentials in hand, not connected. The user starts it from here. */
  | 'ready'
  | 'connecting'
  /**
   * In the room with an agent, mic muted, detector listening on the device.
   * Nothing the user says reaches the agent until "Hey CookMate" or a tap.
   */
  | 'waiting-for-wake-word'
  /**
   * As above, but the detector could not start (web, a missing model, a
   * capture failure). The mic tap still opens a listening window.
   */
  | 'wake-word-unavailable'
  /** A listening window is open: the only state where talking reaches the agent. */
  | 'listening'
  /** In the room, but no worker joined - usually the agent is not running. */
  | 'no-agent'
  /** The OS refused the microphone, so the agent would hear silence. */
  | 'mic-denied'
  | 'error';

/** The session statuses plus the three the screen owns before one can start. */
export type VoiceStatus =
  | VoiceSessionStatus
  /** Fetching LiveKit credentials. */
  | 'preparing'
  /** Credentials could not be obtained, so there is nothing to connect to. */
  | 'unavailable'
  /**
   * Switched off in Settings. Distinct from 'unavailable': nothing is wrong,
   * no token is minted, and the remedy is a preference rather than a retry.
   */
  | 'disabled';

export type VoiceTone = 'neutral' | 'active' | 'warn' | 'error';

/** Ionicons glyphs, checked against the glyph map at author time. */
export type VoiceIcon =
  | 'ellipsis-horizontal-sharp'
  | 'cloud-offline-outline'
  | 'mic-outline'
  | 'mic'
  | 'mic-off-outline'
  | 'alert-circle-outline'
  | 'volume-high';

/**
 * State and remedy are kept apart so the underlying error can be slotted
 * between them. Folded into one string they compete: either the reason is lost
 * or the user is told what happened and not what to do about it.
 *
 * The two are translation keys rather than text: this table is read while
 * rendering, so the wording has to follow whatever language is current then.
 */
interface StatusCopy {
  icon: VoiceIcon;
  /** The state, in the user's terms. Never mentions LiveKit or a worker. */
  stateKey: TranslationKey;
  /** What they can do about it, if anything. */
  actionKey?: TranslationKey;
  tone: VoiceTone;
  /** Whether the state is one the user can retry out of. */
  canRetry: boolean;
}

const COPY: Record<VoiceStatus, StatusCopy> = {
  preparing: {
    icon: 'ellipsis-horizontal-sharp',
    stateKey: 'voice.preparing',
    tone: 'neutral',
    canRetry: false,
  },
  disabled: {
    icon: 'mic-off-outline',
    stateKey: 'voice.disabled',
    actionKey: 'voice.disabledAction',
    tone: 'neutral',
    canRetry: false,
  },
  unavailable: {
    icon: 'cloud-offline-outline',
    stateKey: 'voice.unavailable',
    actionKey: 'voice.unavailableAction',
    tone: 'warn',
    canRetry: true,
  },
  ready: {
    icon: 'mic-outline',
    stateKey: 'voice.ready',
    actionKey: 'voice.readyAction',
    tone: 'neutral',
    canRetry: false,
  },
  connecting: {
    icon: 'ellipsis-horizontal-sharp',
    stateKey: 'voice.connecting',
    tone: 'neutral',
    canRetry: false,
  },
  'waiting-for-wake-word': {
    icon: 'mic-outline',
    stateKey: 'voice.waiting',
    actionKey: 'voice.waitingAction',
    tone: 'neutral',
    canRetry: false,
  },
  'wake-word-unavailable': {
    icon: 'mic-outline',
    stateKey: 'voice.wakeUnavailable',
    actionKey: 'voice.wakeUnavailableAction',
    tone: 'warn',
    canRetry: false,
  },
  listening: {
    icon: 'mic',
    stateKey: 'voice.listening',
    actionKey: 'voice.listeningAction',
    tone: 'active',
    canRetry: false,
  },
  'no-agent': {
    icon: 'cloud-offline-outline',
    stateKey: 'voice.noAgent',
    actionKey: 'voice.noAgentAction',
    tone: 'warn',
    canRetry: true,
  },
  'mic-denied': {
    icon: 'mic-off-outline',
    stateKey: 'voice.micDenied',
    actionKey: 'voice.micDeniedAction',
    tone: 'warn',
    canRetry: true,
  },
  error: {
    icon: 'alert-circle-outline',
    stateKey: 'voice.error',
    actionKey: 'voice.errorAction',
    tone: 'error',
    canRetry: true,
  },
};

export interface VoiceStatusCopy {
  icon: VoiceIcon;
  /** One line, written for someone with their hands in a mixing bowl. */
  label: string;
  tone: VoiceTone;
  /** Whether the state is one the user can retry out of. */
  canRetry: boolean;
}

/**
 * `detail` is the underlying error text when there is one - "Not authenticated"
 * rather than a shrug. It is carried into the label so the person who has to
 * report the problem can read the cause off the screen, and it is the same
 * string the logs record.
 *
 * The translator is passed in rather than read from the module: this runs
 * during render, and a caller's `useTranslation` is what ties the banner to a
 * re-render when the language changes.
 */
export function describeVoiceStatus(
  status: VoiceStatus,
  detail: string | null | undefined,
  t: Translator
): VoiceStatusCopy {
  const { icon, stateKey, actionKey, tone, canRetry } = COPY[status];
  const state = t(stateKey);
  const action = actionKey ? t(actionKey) : undefined;
  const label = [detail ? `${state}: ${detail}` : state, action].filter(Boolean).join(' — ');
  return { icon, label, tone, canRetry };
}

/**
 * Whether the agent is in the room and can talk, whether or not the mic is
 * open. The cooking screen uses this, not 'listening', to keep the device's
 * own step reader quiet: the agent narrates while the user's mic is muted too.
 */
export function isAgentConnected(status: VoiceStatus): boolean {
  return (
    status === 'waiting-for-wake-word' ||
    status === 'wake-word-unavailable' ||
    status === 'listening'
  );
}

export interface VoiceControlIcon {
  name: VoiceIcon;
  color: string;
}

/**
 * The glyph for the toggle in the cooking header. It doubles as the "assistant
 * is talking" indicator: that used to be a second icon and a caption drawn
 * underneath, inside a 44pt circle with room for neither.
 *
 * Both LiveKitVoice implementations draw from here so the native and web builds
 * cannot drift apart on what a given state looks like.
 */
export function voiceControlIcon(
  status: VoiceSessionStatus,
  agentSpeaking: boolean
): VoiceControlIcon {
  switch (status) {
    case 'listening':
      return agentSpeaking
        ? { name: 'volume-high', color: '#4ECDC4' }
        : { name: 'mic', color: '#FFFFFF' };
    case 'waiting-for-wake-word':
      return agentSpeaking
        ? { name: 'volume-high', color: '#4ECDC4' }
        : { name: 'mic-outline', color: '#FFFFFF' };
    case 'wake-word-unavailable':
      return agentSpeaking
        ? { name: 'volume-high', color: '#4ECDC4' }
        : { name: 'mic-outline', color: '#FDE68A' };
    case 'ready':
      return { name: 'mic-outline', color: '#FFFFFF' };
    case 'connecting':
      return { name: 'ellipsis-horizontal-sharp', color: '#FFFFFF' };
    // Connected to the room, but no worker joined - not the same as a
    // connection error, and worth telling the user apart from success.
    case 'no-agent':
      return { name: 'cloud-offline-outline', color: '#FDE68A' };
    case 'mic-denied':
      return { name: 'mic-off-outline', color: '#FDE68A' };
    default:
      return { name: 'alert-circle-outline', color: '#FCA5A5' };
  }
}
