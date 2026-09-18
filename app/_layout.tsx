import type { ReactNode } from 'react';
import { View, ActivityIndicator, Platform, StyleSheet, LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { SettingsProvider } from '../lib/SettingsContext';
import { ShoppingProvider } from '../lib/ShoppingContext';
import { FavoritesProvider } from '../lib/FavoritesContext';
import Auth from '../components/Auth';
import '../global.css';
import { TimerProvider } from '../lib/TimerContext';
import RootStack from '../components/RootStack';

// Suppresses the in-app warning/error pill and its full-screen overlay.
// Errors and warnings still print to the Metro/console output.
LogBox.ignoreAllLogs();

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
            {/* Outside ShoppingProvider and TimerProvider because both the
                timers and the screens they feed read preferences from it. */}
            <SettingsProvider>
              <ShoppingProvider>
                {/* Inside AuthProvider: every favourite belongs to a signed-in
                    user, and the API rejects the write without a session. */}
                <FavoritesProvider>
                  <TimerProvider>
                    <RootLayoutNav />
                  </TimerProvider>
                </FavoritesProvider>
              </ShoppingProvider>
            </SettingsProvider>
          </AuthProvider>
        </SafeAreaProvider>
      </WebMobileViewport>
    </GestureHandlerRootView>
  );
}
