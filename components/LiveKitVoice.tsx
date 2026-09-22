import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View, TouchableOpacity } from 'react-native';
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
  ConnectionState,
  ParticipantEvent,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type MediaDeviceFailure,
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
import type { WindowEffect, WindowMode } from '../lib/listeningWindow';
import { useListeningWindow } from '../hooks/useListeningWindow';
import {
  wakeWordDetector,
  WAKE_THRESHOLD,
  WAKE_THRESHOLD_WHILE_AGENT_SPEAKS,
} from '../lib/wakeWord';
import { playChime } from '../lib/chimes';
import { errorMessage, logger } from '../lib/log';
// Two translators, deliberately: `tStatic` is for strings produced inside
// callbacks (an RPC reply, an error detail), where the language only has to be
// current at the moment they run, and the hook's `t` is for what is rendered,
// which has to re-render when the preference changes.
import { t as tStatic, useTranslation } from '../lib/i18n';
import type { TranslationKey } from '../lib/i18n';

registerGlobals();

const log = logger('voice');

/**
 * How long to wait for the agent worker to join before telling the user. The
 * room connects fine whether or not a worker is running, so without this the
 * UI reports success and the user talks to nobody.
 */
const AGENT_JOIN_TIMEOUT_MS = 10000;

/**
 * The phone is on the counter with the speaker facing the room, so the agent's
 * own voice is loud in the microphone. Uncancelled, the worker's VAD reads that
 * as the user barging in and abandons the reply mid-sentence. Mono at a speech
 * rate for the same reason the web build uses it: nothing downstream benefits
 * from more.
 */
const AUDIO_CAPTURE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
} as const;

/**
 * Navigation callbacks may return a description of the resulting step. That
 * string is handed back to the agent as the RPC result so it can read the new
 * step aloud instead of guessing.
 */
type StepCallback = () => string | void;

/** The statuses only a connected room can know. RoomView owns these. */
type RoomStatus = Extract<
  VoiceSessionStatus,
  'waiting-for-wake-word' | 'wake-word-unavailable' | 'listening' | 'no-agent'
>;

interface LiveKitVoiceProps {
  serverUrl: string;
  token: string;
  /** Live recipe/step state, published to the agent so it can follow along. */
  cookingState?: CookingState | null;
  onNextStep?: StepCallback;
  onPreviousStep?: StepCallback;
  onRepeatStep?: StepCallback;
  /**
   * Connect as soon as the component has credentials and wait for the wake
   * word, rather than waiting for the user to tap the mic. Only the first
   * 'ready' triggers it.
   */
  autoStart?: boolean;
  /** How long a listening window stays open; the user's Settings choice. */
  wakeWindow?: WindowMode;
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
  return (
    status === 'connecting' ||
    status === 'waiting-for-wake-word' ||
    status === 'wake-word-unavailable' ||
    status === 'listening' ||
    status === 'no-agent'
  );
}

/** States where a tap belongs to the listening window rather than the connection. */
function isWindowTap(status: VoiceSessionStatus): boolean {
  return (
    status === 'waiting-for-wake-word' ||
    status === 'wake-word-unavailable' ||
    status === 'listening'
  );
}

/**
 * Renders nothing. It exists so the room hooks have a subscriber inside the
 * LiveKitRoom context. It owns everything that only makes sense in a connected
 * room - the muted mic track, the wake-word detector, the listening window -
 * and reports what it learns upwards, because the one control this component
 * owns is drawn by the parent.
 */
function RoomView({
  cookingState,
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  wakeWindow,
  onRoomStatus,
  onAgentSpeaking,
  onMicFailure,
  registerTap,
  consumePendingOpen,
}: {
  cookingState?: CookingState | null;
  onNextStep?: StepCallback;
  onPreviousStep?: StepCallback;
  onRepeatStep?: StepCallback;
  wakeWindow: WindowMode;
  onRoomStatus: (status: RoomStatus) => void;
  onAgentSpeaking: (speaking: boolean) => void;
  onMicFailure: (detail: string) => void;
  registerTap: (tap: (() => void) | null) => void;
  consumePendingOpen: () => boolean;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const { state, agent } = useVoiceAssistant();
  const agentSpeaking = state === 'speaking';
  const agentPresent = !!agent;
  const agentIdentity = agent?.identity;

  const agentIdentityRef = useRef(agentIdentity);
  agentIdentityRef.current = agentIdentity;
  const agentPresentRef = useRef(agentPresent);
  agentPresentRef.current = agentPresent;

  useEffect(() => {
    onAgentSpeaking(agentSpeaking);
  }, [agentSpeaking, onAgentSpeaking]);

  // Presence immediately, absence only after a grace period - the worker takes
  // a moment to be dispatched and join.
  const [agentMissing, setAgentMissing] = useState(false);
  useEffect(() => {
    if (agentPresent) {
      log.info(`Agent joined the room as ${agentIdentity ?? 'unknown'}`);
      setAgentMissing(false);
      return;
    }
    const timer = setTimeout(() => {
      log.warn(
        `No agent joined within ${AGENT_JOIN_TIMEOUT_MS / 1000}s in room ${room.name}. Check that ` +
          'the worker is running (cd agent && npm install && npm run dev) and that its AGENT_NAME ' +
          "matches the token's agent dispatch."
      );
      setAgentMissing(true);
    }, AGENT_JOIN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [agentPresent, agentIdentity, room.name]);

  // RoomView mounts as soon as the LiveKitRoom starts connecting, well before
  // the signal WebSocket handshake finishes. Publishing before then times out
  // instead of queuing, so track the real connection state and wait for it.
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

  // The listening window. Its effects are the only thing that ever unmutes the
  // microphone.
  const perform = useCallback(
    (effect: WindowEffect) => {
      switch (effect) {
        case 'unmute':
          localParticipant
            .setMicrophoneEnabled(true)
            .catch((e: unknown) => log.error('Could not unmute the microphone', e));
          return;
        case 'mute':
          localParticipant
            .setMicrophoneEnabled(false)
            .catch((e: unknown) => log.error('Could not mute the microphone', e));
          return;
        case 'playOpenChime':
          playChime('open');
          return;
        case 'playCloseTone':
          playChime('close');
          return;
        case 'interruptAgent': {
          const destinationIdentity = agentIdentityRef.current;
          if (!destinationIdentity) return;
          localParticipant
            .performRpc({ destinationIdentity, method: 'interrupt', payload: '' })
            .catch((e: unknown) => log.error('Could not interrupt the agent', e));
          return;
        }
      }
    },
    [localParticipant]
  );
  const { phase, dispatch } = useListeningWindow(wakeWindow, perform);

  // Publish the microphone once, muted. LiveKitRoom is given audio={false} so
  // it never publishes an open mic on connect: from the first frame, nothing
  // the kitchen says reaches the agent until the window opens.
  const [micReady, setMicReady] = useState(false);
  const micRequested = useRef(false);
  useEffect(() => {
    if (!roomConnected || micRequested.current) return;
    micRequested.current = true;
    (async () => {
      const track = await createLocalAudioTrack(AUDIO_CAPTURE);
      await track.mute();
      await localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        // DTX stops sending packets during silence, so the server's VAD is
        // not fed a steady trickle of near-silent frames between words.
        dtx: true,
        red: true,
      });
      setMicReady(true);
    })().catch((e: unknown) => {
      log.error('Could not publish the microphone', e);
      onMicFailure(errorMessage(e, tStatic('voice.detailMicUnavailable')));
    });
  }, [roomConnected, localParticipant, onMicFailure]);

  // Speech events feed the window's silence clock.
  useEffect(() => {
    dispatch(agentSpeaking ? 'agentSpeechStart' : 'agentSpeechEnd');
    wakeWordDetector.setThreshold(agentSpeaking ? WAKE_THRESHOLD_WHILE_AGENT_SPEAKS : WAKE_THRESHOLD);
  }, [agentSpeaking, dispatch]);

  useEffect(() => {
    const handleSpeaking = (speaking: boolean) =>
      dispatch(speaking ? 'userSpeechStart' : 'userSpeechEnd');
    localParticipant.on(ParticipantEvent.IsSpeakingChanged, handleSpeaking);
    return () => {
      localParticipant.off(ParticipantEvent.IsSpeakingChanged, handleSpeaking);
    };
  }, [localParticipant, dispatch]);

  // The detector runs while the room is up and the app is in front. Leaving
  // the foreground closes the window without a sound and stops detection; the
  // room itself stays connected, as it always has.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setAppActive(next === 'active')
    );
    return () => subscription.remove();
  }, []);

  const [detectorAvailable, setDetectorAvailable] = useState(wakeWordDetector.isAvailable);
  useEffect(() => {
    if (!micReady || !appActive || !wakeWordDetector.isAvailable) return;
    const unsubscribe = [
      wakeWordDetector.onDetected((score) => {
        log.info(`Wake word heard (score ${score.toFixed(2)})`);
        // With no agent in the room a chime would promise an answer nobody
        // will give; the no-agent banner is already saying so.
        if (agentPresentRef.current) dispatch('wake');
      }),
      wakeWordDetector.onInterrupted(() => dispatch('reset')),
      wakeWordDetector.onError((message) => {
        log.error(`Wake word detector stopped: ${message}`);
        setDetectorAvailable(false);
      }),
    ];
    wakeWordDetector
      .start(WAKE_THRESHOLD)
      .then(() => setDetectorAvailable(true))
      .catch((e: unknown) => {
        log.error('Wake word detector did not start', e);
        setDetectorAvailable(false);
      });
    return () => {
      unsubscribe.forEach((stop) => stop());
      dispatch('reset');
      wakeWordDetector.stop().catch((e: unknown) => log.error('Wake word detector stop error', e));
    };
  }, [micReady, appActive, dispatch]);

  // The parent's mic button, routed to the window.
  useEffect(() => {
    registerTap(() => dispatch('tap'));
    return () => registerTap(null);
  }, [registerTap, dispatch]);

  // A tap that started the connection also opens the first window, once the
  // mic is published and there is an agent to hear it.
  useEffect(() => {
    if (micReady && agentPresent && consumePendingOpen()) dispatch('tap');
  }, [micReady, agentPresent, consumePendingOpen, dispatch]);

  const status: RoomStatus | null =
    !roomConnected || !micReady
      ? null
      : agentMissing
        ? 'no-agent'
        : phase === 'open'
          ? 'listening'
          : detectorAvailable
            ? 'waiting-for-wake-word'
            : 'wake-word-unavailable';
  useEffect(() => {
    if (status) onRoomStatus(status);
  }, [status, onRoomStatus]);

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
    const rpc = (name: string, run: () => string | void, fallback: TranslationKey) => async () => {
      try {
        const result = run() || tStatic(fallback);
        log.info(`RPC ${name} -> ${result}`);
        return result;
      } catch (e) {
        log.error(`RPC ${name} failed`, e);
        return tStatic('voice.rpcFailed', {
          reason: errorMessage(e, tStatic('voice.rpcFailedReason')),
        });
      }
    };

    room.registerRpcMethod(
      'navigate_next',
      rpc('navigate_next', () => handlers.current.onNextStep?.(), 'voice.rpcNext')
    );
    room.registerRpcMethod(
      'navigate_back',
      rpc('navigate_back', () => handlers.current.onPreviousStep?.(), 'voice.rpcBack')
    );
    room.registerRpcMethod(
      'repeat_step',
      rpc('repeat_step', () => handlers.current.onRepeatStep?.(), 'voice.rpcRepeat')
    );
    // The agent's endListening tool: the user said they are done for now.
    room.registerRpcMethod('close_listening', async () => {
      log.info('RPC close_listening');
      dispatch('endRequested');
      return 'ok';
    });

    return () => {
      room.unregisterRpcMethod('navigate_next');
      room.unregisterRpcMethod('navigate_back');
      room.unregisterRpcMethod('repeat_step');
      room.unregisterRpcMethod('close_listening');
    };
  }, [room, dispatch]);

  return null;
}

const LiveKitVoice: React.FC<LiveKitVoiceProps> = ({
  serverUrl,
  token,
  cookingState,
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  autoStart = false,
  wakeWindow = 'quick',
  onStatusChange,
}) => {
  const { t } = useTranslation();
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

  const handleRoomStatus = useCallback((status: RoomStatus) => {
    setSession((current) =>
      isLive(current.status) && current.status !== status ? { status, detail: null } : current
    );
  }, []);

  const handleMicFailure = useCallback(
    (detail: string) => {
      void stopAudio();
      fail('mic-denied', detail);
    },
    [stopAudio, fail]
  );

  // The mic button, as RoomView wants it handled while connected.
  const windowTap = useRef<(() => void) | null>(null);
  const registerTap = useCallback((tap: (() => void) | null) => {
    windowTap.current = tap;
  }, []);

  // Set when a tap starts the connection, so the first window opens as soon as
  // there is someone to hear it; cleared by RoomView when it acts on it.
  const pendingOpen = useRef(false);
  const consumePendingOpen = useCallback(() => {
    const pending = pendingOpen.current;
    pendingOpen.current = false;
    return pending;
  }, []);

  const startSession = useCallback(
    async (openWhenReady: boolean) => {
      setSession({ status: 'connecting', detail: null });
      try {
        await startAudio();
      } catch (e) {
        // startAudioSession is where a denied microphone surfaces on iOS.
        log.error('Could not start the audio session', e);
        fail('mic-denied', errorMessage(e, tStatic('voice.detailMicUnavailable')));
        return;
      }
      pendingOpen.current = openWhenReady;
      setConnect(true);
    },
    [startAudio, fail]
  );

  const handleTap = useCallback(async () => {
    if (session.status === 'connecting') return;

    if (isWindowTap(session.status)) {
      windowTap.current?.();
      return;
    }

    if (session.status === 'no-agent') {
      // Nobody to talk to: tear down, so the next tap is a clean retry.
      setConnect(false);
      setAgentSpeaking(false);
      await stopAudio();
      setSession(READY);
      return;
    }

    // 'ready', and the retry path out of 'error' / 'mic-denied'.
    await startSession(true);
  }, [session.status, startSession, stopAudio]);

  // Auto-connect, once, straight into waiting for the wake word.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void startSession(false);
  }, [autoStart, startSession]);

  const copy = describeVoiceStatus(session.status, session.detail, t);
  const control = voiceControlIcon(session.status, agentSpeaking);

  return (
    <View>
      <TouchableOpacity
        onPress={handleTap}
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
          // RoomView publishes the mic itself, muted. See the comment there.
          audio={false}
          video={false}
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
            fail('error', errorMessage(err, tStatic('voice.detailUnreachable')));
          }}
          onMediaDeviceFailure={(failure?: MediaDeviceFailure) => {
            // Without this the room stays happily connected while the agent
            // hears silence, which reads to the user as the AI ignoring them.
            log.error(`Microphone failure: ${failure ?? 'unknown'}`);
            void stopAudio();
            fail('mic-denied', tStatic('voice.detailMicFailure', { reason: failure ?? 'unknown' }));
          }}
          options={{
            adaptiveStream: { pixelDensity: 'screen' },
            audioCaptureDefaults: AUDIO_CAPTURE,
            publishDefaults: { dtx: true, red: true },
          }}>
          <RoomView
            cookingState={cookingState}
            onNextStep={onNextStep}
            onPreviousStep={onPreviousStep}
            onRepeatStep={onRepeatStep}
            wakeWindow={wakeWindow}
            onRoomStatus={handleRoomStatus}
            onAgentSpeaking={setAgentSpeaking}
            onMicFailure={handleMicFailure}
            registerTap={registerTap}
            consumePendingOpen={consumePendingOpen}
          />
        </LiveKitRoom>
      )}
    </View>
  );
};

export default LiveKitVoice;
