import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  registerGlobals,
  AudioSession,
  useRoomContext,
  useLocalParticipant,
  LiveKitRoom,
  useVoiceAssistant,
} from '@livekit/react-native';
import { ConnectionState, RoomEvent, type MediaDeviceFailure } from 'livekit-client';
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

registerGlobals();

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

/** States a live room can be torn down from, as opposed to a failure to keep. */
function isLive(status: VoiceSessionStatus): boolean {
  return status === 'connecting' || status === 'listening' || status === 'no-agent';
}

/**
 * Renders nothing. It exists so the room hooks have a subscriber inside the
 * LiveKitRoom context; everything it learns is reported upwards, because the
 * one control this component owns is drawn by the parent. It used to draw a
 * second icon of its own, which the cooking screen's 44pt header circle then
 * had to hold alongside the toggle.
 */
function RoomView({
  cookingState,
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  onAgentPresence,
  onAgentSpeaking,
}: {
  cookingState?: CookingState | null;
  onNextStep?: StepCallback;
  onPreviousStep?: StepCallback;
  onRepeatStep?: StepCallback;
  onAgentPresence?: (present: boolean) => void;
  onAgentSpeaking?: (speaking: boolean) => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const { state, agent } = useVoiceAssistant();
  const agentSpeaking = state === 'speaking';
  const agentPresent = !!agent;
  const agentIdentity = agent?.identity;

  useEffect(() => {
    onAgentSpeaking?.(agentSpeaking);
  }, [agentSpeaking, onAgentSpeaking]);

  // Report presence immediately, absence only after a grace period - the worker
  // takes a moment to be dispatched and join.
  useEffect(() => {
    if (agentPresent) {
      log.info(`Agent joined the room as ${agentIdentity ?? 'unknown'}`);
      onAgentPresence?.(true);
      return;
    }
    const timer = setTimeout(() => {
      log.warn(
        `No agent joined within ${AGENT_JOIN_TIMEOUT_MS / 1000}s in room ${room.name}. Check that ` +
          'the worker is running (cd agent && npm install && npm run dev) and that its AGENT_NAME ' +
          "matches the token's agent dispatch."
      );
      onAgentPresence?.(false);
    }, AGENT_JOIN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [agentPresent, agentIdentity, room.name, onAgentPresence]);

  // RoomView mounts as soon as the LiveKitRoom starts connecting, well before
  // the signal WebSocket handshake finishes. Publishing attributes before then
  // makes setAttributes time out instead of queuing, so track the real
  // connection state and wait for it.
  const [roomConnected, setRoomConnected] = useState(room.state === ConnectionState.Connected);
  useEffect(() => {
    const handleConnectionStateChanged = (state: ConnectionState) => {
      setRoomConnected(state === ConnectionState.Connected);
    };
    room.on(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);
    };
  }, [room]);

  // Publish the current recipe and step to the agent. This runs on connect and
  // on every step change - including manual taps - so the agent never narrates
  // a step the user has already moved past.
  const serializedState = cookingState ? serializeCookingState(cookingState) : null;
  useEffect(() => {
    if (!serializedState || !roomConnected) return;
    localParticipant
      .setAttributes({ [COOKING_STATE_ATTRIBUTE]: serializedState })
      .catch((e: unknown) => log.error('Failed to publish cooking state', e));
  }, [localParticipant, serializedState, roomConnected]);

  // Keep the latest callbacks in a ref so the RPC methods are registered once
  // per room. Re-registering on every render leaves a window where an inbound
  // RPC finds no handler and the agent reports a failure to the user.
  const handlers = useRef({ onNextStep, onPreviousStep, onRepeatStep });
  handlers.current = { onNextStep, onPreviousStep, onRepeatStep };

  useEffect(() => {
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

    return () => {
      room.unregisterRpcMethod('navigate_next');
      room.unregisterRpcMethod('navigate_back');
      room.unregisterRpcMethod('repeat_step');
    };
  }, [room]);

  return null;
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
  const [connect, setConnect] = useState(false);
  const audioStarted = useRef(false);

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

  const fail = useCallback((status: VoiceSessionStatus, detail: string) => {
    setConnect(false);
    setAgentSpeaking(false);
    setSession({ status, detail });
  }, []);

  const startAudio = useCallback(async () => {
    if (audioStarted.current) return;
    await AudioSession.startAudioSession();
    audioStarted.current = true;
  }, []);

  const stopAudio = useCallback(async () => {
    if (!audioStarted.current) return;
    audioStarted.current = false;
    try {
      await AudioSession.stopAudioSession();
    } catch (e) {
      log.error('Audio session stop error', e);
    }
  }, []);

  useEffect(() => {
    return () => {
      void stopAudio();
    };
  }, [stopAudio]);

  const handleAgentPresence = useCallback((present: boolean) => {
    setSession((current) => {
      if (current.status !== 'listening' && current.status !== 'no-agent') return current;
      const status: VoiceSessionStatus = present ? 'listening' : 'no-agent';
      return current.status === status ? current : { status, detail: null };
    });
  }, []);

  const handleToggle = useCallback(async () => {
    if (session.status === 'connecting') return;

    if (isLive(session.status)) {
      setConnect(false);
      setAgentSpeaking(false);
      await stopAudio();
      setSession(READY);
      return;
    }

    // 'ready', and the retry path out of 'error' / 'mic-denied'.
    setSession({ status: 'connecting', detail: null });
    try {
      await startAudio();
    } catch (e) {
      // startAudioSession is where a denied microphone surfaces on iOS.
      log.error('Could not start the audio session', e);
      fail('mic-denied', errorMessage(e, 'The microphone is unavailable'));
      return;
    }
    setConnect(true);
  }, [session.status, startAudio, stopAudio, fail]);

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

      {connect && (
        <LiveKitRoom
          serverUrl={serverUrl}
          token={token}
          connect={connect}
          audio={true}
          video={false}
          onConnected={() => {
            // Presence is unknown for a beat after joining. Assume the worker is
            // on its way rather than flashing "no assistant" on every connect;
            // RoomView downgrades this if nothing turns up.
            setSession({ status: 'listening', detail: null });
          }}
          onDisconnected={() => {
            setConnect(false);
            setAgentSpeaking(false);
            void stopAudio();
            // Unmounting after a failure also lands here - keep the reason.
            setSession((current) => (isLive(current.status) ? READY : current));
          }}
          onError={(err: Error) => {
            log.error('Room error', err);
            void stopAudio();
            fail('error', errorMessage(err, 'Could not reach the voice service'));
          }}
          onMediaDeviceFailure={(failure?: MediaDeviceFailure) => {
            // Without this the room stays happily connected while the agent
            // hears silence, which reads to the user as the AI ignoring them.
            log.error(`Microphone failure: ${failure ?? 'unknown'}`);
            void stopAudio();
            fail('mic-denied', `Microphone unavailable (${failure ?? 'unknown'})`);
          }}
          options={{
            adaptiveStream: { pixelDensity: 'screen' },
          }}>
          <RoomView
            cookingState={cookingState}
            onNextStep={onNextStep}
            onPreviousStep={onPreviousStep}
            onRepeatStep={onRepeatStep}
            onAgentPresence={handleAgentPresence}
            onAgentSpeaking={setAgentSpeaking}
          />
        </LiveKitRoom>
      )}
    </View>
  );
};

export default LiveKitVoice;
