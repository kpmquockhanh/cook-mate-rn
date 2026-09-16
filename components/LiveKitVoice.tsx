import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  TouchableOpacity,
  Text,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  registerGlobals,
  AudioSession,
  useRoomContext,
  useLocalParticipant,
  LiveKitRoom,
  useVoiceAssistant,
} from '@livekit/react-native';
import {
  COOKING_STATE_ATTRIBUTE,
  serializeCookingState,
  type CookingState,
} from '../lib/cookingContext';

registerGlobals();

type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'no-agent' | 'error';

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
  onStarted?: () => void;
  onEnded?: () => void;
  /** Fires when the agent worker joins or is found to be absent. */
  onAgentAvailabilityChange?: (available: boolean) => void;
}

function RoomView({ cookingState, onNextStep, onPreviousStep, onRepeatStep, onAgentPresence }: {
  cookingState?: CookingState | null;
  onNextStep?: StepCallback;
  onPreviousStep?: StepCallback;
  onRepeatStep?: StepCallback;
  onAgentPresence?: (present: boolean) => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const { state, agent } = useVoiceAssistant();
  const agentSpeaking = state === 'speaking';
  const agentPresent = !!agent;

  // Report presence immediately, absence only after a grace period - the worker
  // takes a moment to be dispatched and join.
  useEffect(() => {
    if (agentPresent) {
      onAgentPresence?.(true);
      return;
    }
    const timer = setTimeout(() => onAgentPresence?.(false), AGENT_JOIN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [agentPresent, onAgentPresence]);

  // Publish the current recipe and step to the agent. This runs on connect and
  // on every step change - including manual taps - so the agent never narrates
  // a step the user has already moved past.
  const serializedState = cookingState ? serializeCookingState(cookingState) : null;
  useEffect(() => {
    if (!serializedState) return;
    localParticipant
      .setAttributes({ [COOKING_STATE_ATTRIBUTE]: serializedState })
      .catch((e: unknown) => console.error('[LiveKit] Failed to publish cooking state:', e));
  }, [localParticipant, serializedState]);

  // Keep the latest callbacks in a ref so the RPC methods are registered once
  // per room. Re-registering on every render leaves a window where an inbound
  // RPC finds no handler and the agent reports a failure to the user.
  const handlers = useRef({ onNextStep, onPreviousStep, onRepeatStep });
  handlers.current = { onNextStep, onPreviousStep, onRepeatStep };

  useEffect(() => {
    room.registerRpcMethod('navigate_next', async () => {
      return handlers.current.onNextStep?.() || 'Moved to the next step';
    });
    room.registerRpcMethod('navigate_back', async () => {
      return handlers.current.onPreviousStep?.() || 'Moved to the previous step';
    });
    room.registerRpcMethod('repeat_step', async () => {
      return handlers.current.onRepeatStep?.() || 'Repeated the current step';
    });

    return () => {
      room.unregisterRpcMethod('navigate_next');
      room.unregisterRpcMethod('navigate_back');
      room.unregisterRpcMethod('repeat_step');
    };
  }, [room]);

  return (
    <View style={{ alignItems: 'center' }}>
      <Ionicons
        name={agentSpeaking ? 'volume-high' : 'mic'}
        size={24}
        color={agentSpeaking ? '#4ECDC4' : '#FFFFFF'}
      />
      {agentSpeaking && (
        <Text style={{ color: '#FFFFFF', fontSize: 10, marginTop: 2 }}>
          AI speaking
        </Text>
      )}
    </View>
  );
}

const LiveKitVoice: React.FC<LiveKitVoiceProps> = ({
  serverUrl,
  token,
  cookingState,
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  onStarted,
  onEnded,
  onAgentAvailabilityChange,
}) => {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [connect, setConnect] = useState(false);
  const audioStarted = useRef(false);

  // onDisconnected also fires as the room unmounts, so without this a manual
  // stop would report the session ended twice.
  const endedEmitted = useRef(true);
  const emitEnded = useCallback(() => {
    if (endedEmitted.current) return;
    endedEmitted.current = true;
    onEnded?.();
  }, [onEnded]);

  const handleAgentPresence = useCallback(
    (present: boolean) => {
      onAgentAvailabilityChange?.(present);
      // Only a live session can flip between these two; leave any other status
      // (connecting, error, idle) alone.
      setStatus((current) =>
        current === 'connected' || current === 'no-agent'
          ? present
            ? 'connected'
            : 'no-agent'
          : current
      );
    },
    [onAgentAvailabilityChange]
  );

  const startAudio = useCallback(async () => {
    if (audioStarted.current) return;
    try {
      await AudioSession.startAudioSession();
      audioStarted.current = true;
    } catch (e) {
      console.error('[LiveKit] Audio session error:', e);
    }
  }, []);

  const stopAudio = useCallback(async () => {
    if (!audioStarted.current) return;
    try {
      await AudioSession.stopAudioSession();
      audioStarted.current = false;
    } catch (e) {
      console.error('[LiveKit] Audio session stop error:', e);
    }
  }, []);

  useEffect(() => {
    return () => { stopAudio(); };
  }, [stopAudio]);

  const handleToggle = useCallback(async () => {
    if (status === 'idle' || status === 'error') {
      endedEmitted.current = false;
      setStatus('connecting');
      await startAudio();
      setConnect(true);
    } else if (status === 'connected' || status === 'no-agent') {
      setConnect(false);
      setStatus('idle');
      await stopAudio();
      emitEnded();
    }
  }, [status, startAudio, stopAudio, emitEnded]);

  return (
    <View>
      <TouchableOpacity onPress={handleToggle}>
        {status === 'idle' ? (
          <Ionicons name="volume-mute-outline" size={24} color="white" />
        ) : status === 'connecting' ? (
          <Ionicons name="ellipsis-horizontal-sharp" size={24} color="white" />
        ) : status === 'connected' ? (
          <Ionicons name="volume-high-outline" size={24} color="white" />
        ) : status === 'no-agent' ? (
          // Connected to the room, but no worker joined - not the same as a
          // connection error, and worth telling the user apart from success.
          <Ionicons name="cloud-offline-outline" size={24} color="#FDE68A" />
        ) : (
          <Ionicons name="alert-circle-outline" size={24} color="#FCA5A5" />
        )}
      </TouchableOpacity>

      {connect && (
        <LiveKitRoom
          serverUrl={serverUrl}
          token={token}
          connect={connect}
          audio={true}
          video={false}
          onConnected={() => {
            setStatus('connected');
            onStarted?.();
          }}
          onDisconnected={() => {
            setStatus('idle');
            emitEnded();
          }}
          onError={(err: Error) => {
            console.error('[LiveKit] Room error:', err);
            setStatus('error');
            setConnect(false);
            emitEnded();
          }}
          options={{
            adaptiveStream: { pixelDensity: 'screen' },
          }}
        >
          <RoomView
            cookingState={cookingState}
            onNextStep={onNextStep}
            onPreviousStep={onPreviousStep}
            onRepeatStep={onRepeatStep}
            onAgentPresence={handleAgentPresence}
          />
        </LiveKitRoom>
      )}
    </View>
  );
};

export default LiveKitVoice;
