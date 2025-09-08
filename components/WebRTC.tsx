import { ElevenLabsProvider, useConversation } from '@elevenlabs/react-native';
import type { ConversationStatus, ConversationEvent, Role } from '@elevenlabs/react-native';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  View,
  TouchableOpacity,
  Platform,
} from 'react-native';

interface WebRTCActionsProps {
  onNextStep?: () => void;
  onPreviousStep?: () => void;
  onRepeatStep?: () => void;
  onStarted?: () => void;
  onEnded?: () => void;
}

const ConversationScreen: React.FC<WebRTCActionsProps> = ({
  onNextStep,
  onPreviousStep,
  onRepeatStep,
  onStarted,
  onEnded,
}) => {
  const conversation = useConversation({
    clientTools: {
      next: () => {
        onNextStep?.();
        return 'next';
      },
      back: () => {
        onPreviousStep?.();
        return 'back';
      },
      repeat: () => {
        onRepeatStep?.();
        return 'repeat';
      },
    },
    onConnect: ({ conversationId }: { conversationId: string }) => {
      console.log('✅ Connected to conversation', conversationId);
      onStarted?.();
    },
    onDisconnect: (details: string) => {
      console.log('❌ Disconnected from conversation', details);
      onEnded?.();
    },
    onError: (message: string, context?: Record<string, unknown>) => {
      console.error('❌ Conversation error:', message, context);
      onEnded?.();
    },
    onMessage: ({ message, source }: { message: ConversationEvent; source: Role }) => {
      console.log(`💬 Message from ${source}:`, message);
    },
    onModeChange: ({ mode }: { mode: 'speaking' | 'listening' }) => {
      console.log(`🔊 Mode: ${mode}`);
    },
    onStatusChange: ({ status }: { status: ConversationStatus }) => {
      console.log(`📡 Status: ${status}`);
    },
    onCanSendFeedbackChange: ({ canSendFeedback }: { canSendFeedback: boolean }) => {
      console.log(`🔊 Can send feedback: ${canSendFeedback}`);
    },
  });

  const [isStarting, setIsStarting] = useState(false);

  const startConversation = async () => {
    if (isStarting) return;

    setIsStarting(true);
    try {
      await conversation.startSession({
        agentId: process.env.EXPO_PUBLIC_AGENT_ID,
        dynamicVariables: {
          platform: Platform.OS,
        },
      });
    } catch (error) {
      console.error('Failed to start conversation:', error);
    } finally {
      setIsStarting(false);
    }
  };

  const endConversation = async () => {
    try {
      await conversation.endSession();
    } catch (error) {
      console.error('Failed to end conversation:', error);
    }
  };

  const canStart = conversation.status === 'disconnected' && !isStarting;
  const canEnd = conversation.status === 'connected';
  const isListening = conversation.status === 'connected' && !conversation.isSpeaking;
  const handleToggle = () => {
    if (canStart) startConversation();
    else if (canEnd) endConversation();
  };

  return (
    <View>
      {/* Toggle button */}
      <TouchableOpacity
        onPress={handleToggle}
        disabled={conversation.status === 'connecting' || isStarting}
      >
        <Ionicons
              name= {conversation.status === 'connecting'
                ? 'ellipsis-horizontal-sharp'
                : conversation.status === 'connected'
                ? 'volume-high-outline'
                : isStarting
                ? 'ellipsis-horizontal-sharp'
                : 'volume-mute-outline'}
              size={24}
              color="white"
            />
      </TouchableOpacity>
    </View>
  );
};

const WebRTC: React.FC<WebRTCActionsProps> = (props) => {
  return (
    <ElevenLabsProvider>
      <ConversationScreen {...props} />
    </ElevenLabsProvider>
  );
};

export default WebRTC;
