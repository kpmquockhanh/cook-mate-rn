import { Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { ShoppingProvider } from '../lib/ShoppingContext';
import Auth from '../components/Auth';
import '../global.css';
import { TimerProvider } from '../lib/TimerContext';

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

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: true,
        animation: 'slide_from_right',
      }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="cooking/[id]"
        options={{
          gestureEnabled: true,
          animation: 'slide_from_right',
        }}
      />

    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ShoppingProvider>
          <TimerProvider>
            <RootLayoutNav />
          </TimerProvider>
        </ShoppingProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
