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

/** Statuses the LiveKitVoice component itself reports. */
export type VoiceSessionStatus =
  /** Credentials in hand, not connected. The user starts it from here. */
  | 'ready'
  | 'connecting'
  /** In the room with an agent worker: the only state where talking works. */
  | 'listening'
  /** In the room, but no worker joined - usually the agent is not running. */
  | 'no-agent'
  /** The OS refused the microphone, so the agent would hear silence. */
  | 'mic-denied'
  | 'error';

/** The session statuses plus the two the screen owns while minting a token. */
export type VoiceStatus =
  | VoiceSessionStatus
  /** Fetching LiveKit credentials. */
  | 'preparing'
  /** Credentials could not be obtained, so there is nothing to connect to. */
  | 'unavailable';

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
 */
interface StatusCopy {
  icon: VoiceIcon;
  /** The state, in the user's terms. Never mentions LiveKit or a worker. */
  state: string;
  /** What they can do about it, if anything. */
  action?: string;
  tone: VoiceTone;
  /** Whether the state is one the user can retry out of. */
  canRetry: boolean;
}

const COPY: Record<VoiceStatus, StatusCopy> = {
  preparing: {
    icon: 'ellipsis-horizontal-sharp',
    state: 'Getting the voice assistant ready…',
    tone: 'neutral',
    canRetry: false,
  },
  unavailable: {
    icon: 'cloud-offline-outline',
    state: 'Voice assistant unavailable',
    action: 'tap to try again',
    tone: 'warn',
    canRetry: true,
  },
  ready: {
    icon: 'mic-outline',
    state: 'Voice assistant ready',
    action: 'tap the mic to cook hands-free',
    tone: 'neutral',
    canRetry: false,
  },
  connecting: {
    icon: 'ellipsis-horizontal-sharp',
    state: 'Connecting to the voice assistant…',
    tone: 'neutral',
    canRetry: false,
  },
  listening: {
    icon: 'mic',
    state: 'Listening',
    action: 'say “next step”, “go back” or “repeat”',
    tone: 'active',
    canRetry: false,
  },
  'no-agent': {
    icon: 'cloud-offline-outline',
    state: 'No assistant answered',
    action: 'use the buttons below, or tap the mic to retry',
    tone: 'warn',
    canRetry: true,
  },
  'mic-denied': {
    icon: 'mic-off-outline',
    state: 'Microphone is off',
    action: 'allow it, then tap the mic again',
    tone: 'warn',
    canRetry: true,
  },
  error: {
    icon: 'alert-circle-outline',
    state: 'Voice assistant error',
    action: 'tap the mic to retry',
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
 */
export function describeVoiceStatus(status: VoiceStatus, detail?: string | null): VoiceStatusCopy {
  const { icon, state, action, tone, canRetry } = COPY[status];
  const label = [detail ? `${state}: ${detail}` : state, action].filter(Boolean).join(' — ');
  return { icon, label, tone, canRetry };
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
