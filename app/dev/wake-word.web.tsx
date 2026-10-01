import React from 'react';
import { Text } from 'react-native';

/**
 * Web build of the wake-word dev screen. The native screen imports
 * `@livekit/react-native`, whose WebRTC dependency calls
 * `requireNativeComponent` at module load - an API react-native-web doesn't
 * have - and Expo Router loads every route on web, so that import would crash
 * the whole app. The wake-word module is native-only anyway.
 */
export default function WakeWordDevScreen() {
  return <Text className="p-6">The wake word dev screen is native-only.</Text>;
}
