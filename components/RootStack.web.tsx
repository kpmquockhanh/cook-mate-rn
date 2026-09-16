import type { ParamListBase, StackNavigationState } from '@react-navigation/native';
import {
  createStackNavigator,
  type StackNavigationEventMap,
  type StackNavigationOptions,
} from '@react-navigation/stack';
import { withLayoutContext } from 'expo-router';
import { ROOT_SCREENS, TRANSITION_DURATION, type ScreenTransition } from '../lib/navigationRoutes';

const { Navigator } = createStackNavigator();

// expo-router drives this navigator from the file-based routes in app/.
const JsStack = withLayoutContext<
  StackNavigationOptions,
  typeof Navigator,
  StackNavigationState<ParamListBase>,
  StackNavigationEventMap
>(Navigator);

const ANIMATION: Record<ScreenTransition, StackNavigationOptions['animation']> = {
  slide: 'slide_from_right',
  fade: 'fade',
  modal: 'slide_from_bottom',
};

// `animation` must be set explicitly: @react-navigation/stack defaults it to
// 'none' on web (getDefaultAnimation in views/Stack/CardStack.js), so supplying
// only a TransitionPreset leaves transitions disabled.
const timing = { animation: 'timing', config: { duration: TRANSITION_DURATION } } as const;

export default function RootStack() {
  return (
    <JsStack
      screenOptions={{
        headerShown: false,
        gestureEnabled: true,
        cardStyle: { backgroundColor: '#fff' },
      }}>
      {ROOT_SCREENS.map(({ name, transition }) => (
        <JsStack.Screen
          key={name}
          name={name}
          options={{
            animation: ANIMATION[transition],
            transitionSpec: { open: timing, close: timing },
          }}
        />
      ))}
    </JsStack>
  );
}
