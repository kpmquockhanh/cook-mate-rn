import { Stack } from 'expo-router';
import {
  ROOT_SCREENS,
  TRANSITION_DURATION,
  type ScreenTransition,
  type StackScreen,
} from '../lib/navigationRoutes';

const ANIMATION: Record<ScreenTransition, 'slide_from_right' | 'fade' | 'slide_from_bottom'> = {
  slide: 'slide_from_right',
  fade: 'fade',
  modal: 'slide_from_bottom',
};

export default function RootStack({ screens = ROOT_SCREENS }: { screens?: StackScreen[] }) {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: true,
        gestureDirection: 'horizontal',
        animationDuration: TRANSITION_DURATION,
        contentStyle: { backgroundColor: '#fff' },
      }}>
      {screens.map(({ name, transition }) => (
        <Stack.Screen key={name} name={name} options={{ animation: ANIMATION[transition] }} />
      ))}
    </Stack>
  );
}
