import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  ParticipantKind,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
} from 'livekit-client';
import {
  COOKING_STATE_ATTRIBUTE,
  serializeCookingState,
  type CookingState,
} from '../lib/cookingContext';
import {
  describeVoiceStatus,
  voiceControlIcon,
  type VoiceSessionStatus,
} from '../lib/voiceSession';
import { errorMessage, logger } from '../lib/log';

// Web build of LiveKitVoice. `@livekit/react-native` pulls in
// `@livekit/react-native-webrtc`, which calls `requireNativeComponent` - an API
// react-native-web 0.21 no longer exports, so merely importing it crashes the
// browser bundle. Browsers ship WebRTC natively, so here we drive
// `livekit-client` directly and keep the same props and UI as the native file.

const log = logger('voice');

/**
 * How long to wait for the agent worker to join before telling the user. The
 * room connects fine whether or not a worker is running, so without this the
 * UI reports success and the user talks to nobody.
 */
const AGENT_JOIN_TIMEOUT_MS = 10000;

/**
 * Navigation callbacks may return a description of the resulting step. That
 * string is handed back to the agent as the RPC result so it can read the new
 * step aloud instead of guessing.
 */
type StepCallback = () => string | void;

interface LiveKitVoiceProps {
  serverUrl: string;
  token: string;
  /** Live recipe/step state, published to the agent so it can follow along. */
  cookingState?: CookingState | null;
  onNextStep?: StepCallback;
  onPreviousStep?: StepCallback;
  onRepeatStep?: StepCallback;
  /**
   * Every state change, with the underlying reason when the state is a failure.
   * The cooking screen is what turns this into a line the user can read.
   */
  onStatusChange?: (status: VoiceSessionStatus, detail: string | null) => void;
}

/** Session state and, for a failure, why - always changed together. */
interface Session {
  status: VoiceSessionStatus;
  detail: string | null;
}

const READY: Session = { status: 'ready', detail: null };

const isAgent = (p: RemoteParticipant) => p.kind === ParticipantKind.AGENT;

/** States a live room can be torn down from, as opposed to a failure to keep. */
function isLive(status: VoiceSessionStatus): boolean {
  return status === 'connecting' || status === 'listening' || status === 'no-agent';
}

/**
 * A rejected getUserMedia is the browser's way of saying the microphone is off,
 * and it is the single most common reason the assistant "does not work".
 */
function isMicrophoneDenial(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === 'NotAllowedError' || name === 'NotFoundError' || name === 'PermissionDeniedError';
}

const LiveKitVoice: React.FC<LiveKitVoiceProps> = ({
  serverUrl,
  token,
  cookingState,
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  onStatusChange,
}) => {
  const [session, setSession] = useState<Session>(READY);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const roomRef = useRef<Room | null>(null);

  // One place reports every transition, so the screen's banner and the logs can
  // never disagree about what the session is doing. The ref holds the callback
  // so that a parent re-render cannot re-fire the report; it is refreshed in an
  // effect declared first, which therefore runs before the reporting one in the
  // same commit.
  const reportRef = useRef(onStatusChange);
  useEffect(() => {
    reportRef.current = onStatusChange;
  });
  useEffect(() => {
    log.info(`Status -> ${session.status}${session.detail ? `: ${session.detail}` : ''}`);
    reportRef.current?.(session.status, session.detail);
  }, [session]);

  // Keep the latest callbacks in a ref so the RPC methods are registered once
  // per room. Re-registering on every render leaves a window where an inbound
  // RPC finds no handler and the agent reports a failure to the user.
  const handlers = useRef({ onNextStep, onPreviousStep, onRepeatStep });
  handlers.current = { onNextStep, onPreviousStep, onRepeatStep };

  const reportPresence = useCallback((present: boolean) => {
    setSession((current) => {
      if (current.status !== 'listening' && current.status !== 'no-agent') return current;
      const status: VoiceSessionStatus = present ? 'listening' : 'no-agent';
      return current.status === status ? current : { status, detail: null };
    });
  }, []);

  const teardown = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    setAgentSpeaking(false);
    if (room) await room.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      void teardown();
    };
  }, [teardown]);

  // Publish the current recipe and step to the agent. This runs on connect and
  // on every step change - including manual taps - so the agent never narrates
  // a step the user has already moved past.
  const serializedState = cookingState ? serializeCookingState(cookingState) : null;
  const liveStatus = isLive(session.status) ? session.status : null;
  useEffect(() => {
    if (!serializedState || !liveStatus) return;
    const room = roomRef.current;
    if (!room) return;
    room.localParticipant
      .setAttributes({ [COOKING_STATE_ATTRIBUTE]: serializedState })
      .catch((e: unknown) => log.error('Failed to publish cooking state', e));
  }, [serializedState, liveStatus]);

  const connect = useCallback(async () => {
    const room = new Room({ adaptiveStream: { pixelDensity: 'screen' } });
    roomRef.current = room;

    let agentTimer: ReturnType<typeof setTimeout> | undefined;
    const checkAgent = () => {
      clearTimeout(agentTimer);
      const present = [...room.remoteParticipants.values()].find(isAgent);
      if (present) {
        log.info(`Agent joined the room as ${present.identity}`);
        reportPresence(true);
        return;
      }
      // Absence only counts after a grace period - the worker takes a moment
      // to be dispatched and join.
      agentTimer = setTimeout(() => {
        log.warn(
          `No agent joined within ${AGENT_JOIN_TIMEOUT_MS / 1000}s in room ${room.name}. Check ` +
            'that the worker is running (cd agent && npm install && npm run dev) and that its ' +
            "AGENT_NAME matches the token's agent dispatch."
        );
        reportPresence(false);
      }, AGENT_JOIN_TIMEOUT_MS);
    };

    room
      // Browsers do not auto-play remote audio; every subscribed audio track
      // needs its own element in the DOM to be heard.
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
      })
      .on(RoomEvent.ParticipantConnected, checkAgent)
      .on(RoomEvent.ParticipantDisconnected, checkAgent)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        setAgentSpeaking(speakers.some((s) => s.kind === ParticipantKind.AGENT));
      })
      .on(RoomEvent.MediaDevicesError, (e: Error) => {
        log.error('Microphone failure', e);
        void teardown();
        clearTimeout(agentTimer);
        setSession({
          status: 'mic-denied',
          detail: errorMessage(e, 'The browser blocked the microphone'),
        });
      })
      .on(RoomEvent.Disconnected, (reason) => {
        log.info(`Disconnected from the room (reason ${reason ?? 'unknown'})`);
        clearTimeout(agentTimer);
        roomRef.current = null;
        setAgentSpeaking(false);
        // A teardown after a failure also lands here - keep the reason.
        setSession((current) => (isLive(current.status) ? READY : current));
      });

    await room.connect(serverUrl, token);

    // The agent reads the returned string aloud, so a throw here becomes an
    // unexplained apology in the user's ear. Log it, answer with something
    // sayable.
    const rpc = (name: string, run: () => string | void, fallback: string) => async () => {
      try {
        const result = run() || fallback;
        log.info(`RPC ${name} -> ${result}`);
        return result;
      } catch (e) {
        log.error(`RPC ${name} failed`, e);
        return `Sorry, I could not do that: ${errorMessage(e, 'something went wrong')}`;
      }
    };

    room.registerRpcMethod(
      'navigate_next',
      rpc('navigate_next', () => handlers.current.onNextStep?.(), 'Moved to the next step')
    );
    room.registerRpcMethod(
      'navigate_back',
      rpc('navigate_back', () => handlers.current.onPreviousStep?.(), 'Moved to the previous step')
    );
    room.registerRpcMethod(
      'repeat_step',
      rpc('repeat_step', () => handlers.current.onRepeatStep?.(), 'Repeated the current step')
    );

    await room.localParticipant.setMicrophoneEnabled(true);
    // Toggling happens inside a click handler, so autoplay is unblocked here.
    await room.startAudio();

    setSession({ status: 'listening', detail: null });
    checkAgent();
  }, [serverUrl, token, reportPresence, teardown]);

  const handleToggle = useCallback(async () => {
    if (session.status === 'connecting') return;

    if (isLive(session.status)) {
      setSession(READY);
      await teardown();
      return;
    }

    // 'ready', and the retry path out of 'error' / 'mic-denied'.
    setSession({ status: 'connecting', detail: null });
    try {
      await connect();
    } catch (err) {
      await teardown();
      if (isMicrophoneDenial(err)) {
        log.error('Microphone denied', err);
        setSession({
          status: 'mic-denied',
          detail: errorMessage(err, 'The browser blocked the microphone'),
        });
        return;
      }
      log.error('Room error', err);
      setSession({
        status: 'error',
        detail: errorMessage(err, 'Could not reach the voice service'),
      });
    }
  }, [session.status, connect, teardown]);

  const copy = describeVoiceStatus(session.status, session.detail);
  const control = voiceControlIcon(session.status, agentSpeaking);

  return (
    <View>
      <TouchableOpacity
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={copy.label}
        accessibilityState={{ disabled: session.status === 'connecting' }}>
        <Ionicons name={control.name} size={24} color={control.color} />
      </TouchableOpacity>
    </View>
  );
};

export default LiveKitVoice;
