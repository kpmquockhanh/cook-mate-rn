import React, { useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { AudioSession, LiveKitRoom, useVoiceAssistant, registerGlobals } from '@livekit/react-native';
import WakeWord from '../../modules/wake-word';
import { useLiveKitToken } from '../../lib/livekitToken';

registerGlobals();

/**
 * Open with cookmate://dev/wake-word?recipe=<recipe id>.
 *
 * The spike: run the module's capture and a LiveKit room at the same time and
 * watch both. The level bar is our capture; "agent" is LiveKit's view.
 */
export default function WakeWordDevScreen() {
  const { recipe } = useLocalSearchParams<{ recipe?: string }>();
  const { credentials } = useLiveKitToken(recipe ?? null);
  const [capturing, setCapturing] = useState(false);
  const [connected, setConnected] = useState(false);
  const [rms, setRms] = useState(0);
  const [events, setEvents] = useState<string[]>([]);

  const logEvent = (line: string) =>
    setEvents((all) => [`${new Date().toLocaleTimeString()} ${line}`, ...all].slice(0, 30));

  useEffect(() => {
    if (!WakeWord) return;
    const subs = [
      WakeWord.addListener('onLevel', ({ rms }) => setRms(rms)),
      WakeWord.addListener('onError', ({ message }) => logEvent(`error: ${message}`)),
      WakeWord.addListener('onWakeWord', ({ score }) => logEvent(`WAKE ${score.toFixed(2)}`)),
      WakeWord.addListener('onInterrupted', () => logEvent('interrupted')),
      WakeWord.addListener('onResumed', () => logEvent('resumed')),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  if (!__DEV__) return <Redirect href="/" />;
  if (!WakeWord) return <Text className="p-6">WakeWord native module is not linked in this build.</Text>;
  // Narrowing on a module-level import doesn't carry into the closures below
  // (TS can't prove it stays non-null across a later call), so bind it here.
  const wakeWord = WakeWord;

  const toggleCapture = async () => {
    try {
      if (capturing) await wakeWord.stop();
      else await wakeWord.start(0.5);
      setCapturing(!capturing);
      logEvent(capturing ? 'capture stopped' : 'capture started');
    } catch (e) {
      logEvent(`start failed: ${String(e)}`);
    }
  };

  const toggleRoom = async () => {
    if (connected) {
      setConnected(false);
      await AudioSession.stopAudioSession();
    } else {
      await AudioSession.startAudioSession();
      setConnected(true);
    }
  };

  return (
    <ScrollView className="flex-1 bg-white p-6 pt-16">
      <Text className="mb-4 text-xl font-bold">Wake word dev</Text>
      <Button label={capturing ? 'Stop capture' : 'Start capture'} onPress={toggleCapture} />
      <Button
        label={connected ? 'Disconnect room' : credentials ? 'Connect room' : 'Waiting for token…'}
        onPress={credentials ? toggleRoom : undefined}
      />
      <Text className="mt-4">Capture level</Text>
      <View className="h-4 w-full bg-gray-200">
        <View className="h-4 bg-orange-500" style={{ width: `${Math.min(100, rms * 400)}%` }} />
      </View>
      {connected && credentials && (
        <LiveKitRoom serverUrl={credentials.serverUrl} token={credentials.token} connect audio video={false}>
          <AgentState />
        </LiveKitRoom>
      )}
      <Text className="mt-4 font-semibold">Events</Text>
      {events.map((line, i) => (
        <Text key={i} className="font-mono text-xs">
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

function AgentState() {
  const { state, agent } = useVoiceAssistant();
  return <Text className="mt-4">Agent: {agent ? state : 'not joined'}</Text>;
}

function Button({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} className="mb-2 rounded-xl bg-gray-800 p-3">
      <Text className="text-center text-white">{label}</Text>
    </TouchableOpacity>
  );
}
