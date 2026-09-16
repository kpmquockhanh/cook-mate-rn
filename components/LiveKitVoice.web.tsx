import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Text } from 'react-native';
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

// Web build of LiveKitVoice. `@livekit/react-native` pulls in
// `@livekit/react-native-webrtc`, which calls `requireNativeComponent` - an API
// react-native-web 0.21 no longer exports, so merely importing it crashes the
// browser bundle. Browsers ship WebRTC natively, so here we drive
// `livekit-client` directly and keep the same props and UI as the native file.

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

const isAgent = (p: RemoteParticipant) => p.kind === ParticipantKind.AGENT;

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
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const roomRef = useRef<Room | null>(null);

  // onDisconnected also fires as we tear the room down, so without this a
  // manual stop would report the session ended twice.
  const endedEmitted = useRef(true);
  const emitEnded = useCallback(() => {
    if (endedEmitted.current) return;
    endedEmitted.current = true;
    onEnded?.();
  }, [onEnded]);

  // Keep the latest callbacks in a ref so the RPC methods are registered once
  // per room. Re-registering on every render leaves a window where an inbound
  // RPC finds no handler and the agent reports a failure to the user.
  const handlers = useRef({ onNextStep, onPreviousStep, onRepeatStep });
  handlers.current = { onNextStep, onPreviousStep, onRepeatStep };

  const availabilityRef = useRef(onAgentAvailabilityChange);
  availabilityRef.current = onAgentAvailabilityChange;

  const reportPresence = useCallback((present: boolean) => {
    availabilityRef.current?.(present);
    // Only a live session can flip between these two; leave any other status
    // (connecting, error, idle) alone.
    setStatus((current) =>
      current === 'connected' || current === 'no-agent'
        ? present
          ? 'connected'
          : 'no-agent'
        : current
    );
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
  useEffect(() => {
    if (!serializedState) return;
    const room = roomRef.current;
    if (!room || status === 'idle' || status === 'connecting' || status === 'error') return;
    room.localParticipant
      .setAttributes({ [COOKING_STATE_ATTRIBUTE]: serializedState })
      .catch((e: unknown) => console.error('[LiveKit] Failed to publish cooking state:', e));
  }, [serializedState, status]);

  const connect = useCallback(async () => {
    const room = new Room({ adaptiveStream: { pixelDensity: 'screen' } });
    roomRef.current = room;

    let agentTimer: ReturnType<typeof setTimeout> | undefined;
    const checkAgent = () => {
      const present = [...room.remoteParticipants.values()].some(isAgent);
      if (present) {
        clearTimeout(agentTimer);
        reportPresence(true);
        return;
      }
      // Absence only counts after a grace period - the worker takes a moment
      // to be dispatched and join.
      clearTimeout(agentTimer);
      agentTimer = setTimeout(() => reportPresence(false), AGENT_JOIN_TIMEOUT_MS);
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
      .on(RoomEvent.Disconnected, () => {
        clearTimeout(agentTimer);
        roomRef.current = null;
        setAgentSpeaking(false);
        setStatus('idle');
        emitEnded();
      });

    await room.connect(serverUrl, token);

    room.registerRpcMethod('navigate_next', async () =>
      handlers.current.onNextStep?.() || 'Moved to the next step'
    );
    room.registerRpcMethod('navigate_back', async () =>
      handlers.current.onPreviousStep?.() || 'Moved to the previous step'
    );
    room.registerRpcMethod('repeat_step', async () =>
      handlers.current.onRepeatStep?.() || 'Repeated the current step'
    );

    await room.localParticipant.setMicrophoneEnabled(true);
    // Toggling happens inside a click handler, so autoplay is unblocked here.
    await room.startAudio();

    setStatus('connected');
    onStarted?.();
    checkAgent();
  }, [serverUrl, token, emitEnded, onStarted, reportPresence]);

  const handleToggle = useCallback(async () => {
    if (status === 'idle' || status === 'error') {
      endedEmitted.current = false;
      setStatus('connecting');
      try {
        await connect();
      } catch (err) {
        console.error('[LiveKit] Room error:', err);
        await teardown();
        setStatus('error');
        emitEnded();
      }
    } else if (status === 'connected' || status === 'no-agent') {
      setStatus('idle');
      await teardown();
      emitEnded();
    }
  }, [status, connect, teardown, emitEnded]);

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

      {agentSpeaking && (
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: '#FFFFFF', fontSize: 10, marginTop: 2 }}>AI speaking</Text>
        </View>
      )}
    </View>
  );
};

export default LiveKitVoice;
