import { View, ActivityIndicator } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import { ShoppingProvider } from '../lib/ShoppingContext';
import Auth from '../components/Auth';
import '../global.css';
import { TimerProvider } from '../lib/TimerContext';
import RootStack from '../components/RootStack';

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
      <SafeAreaProvider>
        <AuthProvider>
          <ShoppingProvider>
            <TimerProvider>
              <RootLayoutNav />
            </TimerProvider>
          </ShoppingProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
