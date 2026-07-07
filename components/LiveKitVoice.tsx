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
import { RoomEvent } from 'livekit-client';

registerGlobals();

type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'error';

interface LiveKitVoiceProps {
  serverUrl: string;
  token: string;
  onNextStep?: () => void;
  onPreviousStep?: () => void;
  onRepeatStep?: () => void;
  onStarted?: () => void;
  onEnded?: () => void;
}

function RoomView({ onNextStep, onPreviousStep, onRepeatStep }: {
  onNextStep?: () => void;
  onPreviousStep?: () => void;
  onRepeatStep?: () => void;
}) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const { agentTranscriptions } = useVoiceAssistant();
  const [agentSpeaking, setAgentSpeaking] = useState(false);

  useEffect(() => {
    const handleSpeakingChanged = () => {
      setAgentSpeaking(localParticipant.isSpeaking);
    };
    room.on(RoomEvent.LocalTrackPublished, handleSpeakingChanged);
    return () => { room.off(RoomEvent.LocalTrackPublished, handleSpeakingChanged); };
  }, [room, localParticipant]);

  useEffect(() => {
    room.registerRpcMethod('navigate_next', async () => {
      onNextStep?.();
      return 'Navigated to next step';
    });
    room.registerRpcMethod('navigate_back', async () => {
      onPreviousStep?.();
      return 'Navigated to previous step';
    });
    room.registerRpcMethod('repeat_step', async () => {
      onRepeatStep?.();
      return 'Repeated current step';
    });

    return () => {
      room.unregisterRpcMethod('navigate_next');
      room.unregisterRpcMethod('navigate_back');
      room.unregisterRpcMethod('repeat_step');
    };
  }, [room, onNextStep, onPreviousStep, onRepeatStep]);

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
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  onStarted,
  onEnded,
}) => {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [connect, setConnect] = useState(false);
  const audioStarted = useRef(false);

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
    if (status === 'idle') {
      setStatus('connecting');
      await startAudio();
      setConnect(true);
    } else if (status === 'connected') {
      setConnect(false);
      setStatus('idle');
      await stopAudio();
      onEnded?.();
    }
  }, [status, startAudio, stopAudio, onEnded]);

  return (
    <View>
      <TouchableOpacity onPress={handleToggle}>
        {status === 'idle' ? (
          <Ionicons name="volume-mute-outline" size={24} color="white" />
        ) : status === 'connecting' ? (
          <Ionicons name="ellipsis-horizontal-sharp" size={24} color="white" />
        ) : status === 'connected' ? (
          <Ionicons name="volume-high-outline" size={24} color="white" />
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
            onEnded?.();
          }}
          onError={(err: Error) => {
            console.error('[LiveKit] Room error:', err);
            setStatus('error');
            setConnect(false);
          }}
          options={{
            adaptiveStream: { pixelDensity: 'screen' },
          }}
        >
          <RoomView
            onNextStep={onNextStep}
            onPreviousStep={onPreviousStep}
            onRepeatStep={onRepeatStep}
          />
        </LiveKitRoom>
      )}
    </View>
  );
};

export default LiveKitVoice;
