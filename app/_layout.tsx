import type { ReactNode } from 'react';
import { View, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { ShoppingProvider } from '../lib/ShoppingContext';
import Auth from '../components/Auth';
import '../global.css';
import { TimerProvider } from '../lib/TimerContext';
import RootStack from '../components/RootStack';

// Caps the app to a phone-width column on wide (desktop) browsers so the
// layout keeps a mobile aspect ratio instead of stretching edge-to-edge;
// on native and narrow web viewports this is a no-op. Exported so screens
// that size themselves off useWindowDimensions() (which reports the full
// browser window, not this frame) can clamp to the same width.
export const WEB_MOBILE_MAX_WIDTH = 430;

const webViewportStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    backgroundColor: '#e2e2e2',
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: WEB_MOBILE_MAX_WIDTH,
    backgroundColor: '#fff',
  },
});

function WebMobileViewport({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  return (
    <View style={webViewportStyles.backdrop}>
      <View style={webViewportStyles.frame}>{children}</View>
    </View>
  );
}

function RootLayoutNav() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  if (!user) {
    return <Auth />;
  }

  return <RootStack />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <WebMobileViewport>
        <SafeAreaProvider>
          <AuthProvider>
            <ShoppingProvider>
              <TimerProvider>
                <RootLayoutNav />
              </TimerProvider>
            </ShoppingProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </WebMobileViewport>
    </GestureHandlerRootView>
  );
}
