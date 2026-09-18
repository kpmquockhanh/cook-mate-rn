import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from '../../lib/i18n';

const SIZE = 64;

/**
 * Each ring is described once, outermost last. Staggering the starts is what
 * turns three rings into a single wave travelling outwards; fired together
 * they read as one thick flash.
 */
const RIPPLES = [
  { scaleTo: 1.7, delay: 0, color: '#FF6B6B' },
  { scaleTo: 1.95, delay: 110, color: '#FF8E53' },
  { scaleTo: 2.2, delay: 220, color: '#FF6B6B' },
];
const RIPPLE_DURATION = 900;

/**
 * A ring is driven by a single 0->1 value rather than a scale animation and a
 * separate opacity animation. Two timings of the same duration drift apart
 * under load, which leaves a ring visible at full size or gone at half size;
 * reading both off one progress value makes that impossible.
 */
function Ripple({
  progress,
  scaleTo,
  color,
}: {
  progress: SharedValue<number>;
  scaleTo: number;
  color: string;
}) {
  const style = useAnimatedStyle(() => ({
    // Starts at 1, i.e. exactly the button's outline, so the wave looks like it
    // is shed by the button. The old version grew from 0 and so began as a dot
    // expanding through the middle of the mic.
    transform: [{ scale: interpolate(progress.value, [0, 1], [1, scaleTo]) }],
    // The short ramp in front avoids a hard-edged ring appearing at full
    // strength on the first frame.
    opacity: interpolate(progress.value, [0, 0.12, 1], [0, 0.55, 0]),
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          width: SIZE,
          height: SIZE,
          borderRadius: SIZE / 2,
          borderWidth: 2,
          borderColor: color,
        },
        style,
      ]}
    />
  );
}

export default function SpecialTabBarButton() {
  const { t } = useTranslation();
  const ripple0 = useSharedValue(0);
  const ripple1 = useSharedValue(0);
  const ripple2 = useSharedValue(0);
  const ripples = [ripple0, ripple1, ripple2];

  /** 0 at rest, 1 held down. Every press-driven style is derived from it. */
  const press = useSharedValue(0);
  /** Slow ambient breath, so the primary action does not sit inert. */
  const idle = useSharedValue(0);

  useEffect(() => {
    idle.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 1800, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
    return () => cancelAnimation(idle);
  }, [idle]);

  const startRipples = () => {
    RIPPLES.forEach(({ delay }, i) => {
      ripples[i].value = 0;
      ripples[i].value = withDelay(
        delay,
        // Decelerating: fast off the edge, then settling, the way a real
        // ripple loses energy. Linear expansion looks mechanical.
        withTiming(1, { duration: RIPPLE_DURATION, easing: Easing.out(Easing.cubic) })
      );
    });
  };

  const handlePressIn = () => {
    startRipples();
    // Timing, not a spring, on the way down: a spring here lags behind the
    // finger and the button feels soft rather than responsive.
    press.value = withTiming(1, { duration: 110, easing: Easing.out(Easing.quad) });
  };

  const handlePressOut = () => {
    // Underdamped on the way back so it overshoots past its resting size and
    // pops. `interpolate` extends beyond its output range by default, so the
    // spring undershooting 0 is what produces the scale above 1.
    press.value = withSpring(0, { damping: 8, stiffness: 280, mass: 0.5 });
  };

  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(idle.value, [0, 1], [1, 1.22]) }],
    // Yields to the press: the breath and the ripples fighting for the same
    // ring of pixels just reads as flicker.
    opacity: interpolate(idle.value, [0, 1], [0.18, 0]) * (1 - press.value),
  }));

  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(press.value, [0, 1], [1, 0.88]) }],
  }));

  const iconStyle = useAnimatedStyle(() => ({
    // Grows while the button compresses. The opposition is what sells the
    // press as a physical squeeze instead of a uniform shrink.
    transform: [{ scale: interpolate(press.value, [0, 1], [1, 1.12]) }],
  }));

  return (
    <View
      style={{
        borderRadius: 50,
        margin: 'auto',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        top: -20,
        width: SIZE,
        height: SIZE,
        ...Platform.select({
          ios: {
            shadowColor: '#FF6B6B',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.25,
            shadowRadius: 10,
          },
          android: {
            elevation: 10,
          },
        }),
      }}>
      {/* Resting glow, underneath everything else. */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            backgroundColor: '#FF6B6B',
          },
          haloStyle,
        ]}
      />

      {RIPPLES.map(({ scaleTo, color }, i) => (
        <Ripple key={i} progress={ripples[i]} scaleTo={scaleTo} color={color} />
      ))}

      <Animated.View style={buttonStyle}>
        {/* Pressable rather than TouchableOpacity: TouchableOpacity dims the
            button on its own, which double-counts against the scale feedback
            and cannot be tuned. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tabs.voiceAssistant')}
          hitSlop={8}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}>
          <LinearGradient
            colors={['#FF6B6B', '#FF8E53']}
            start={{ x: 0.5, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{
              width: SIZE,
              height: SIZE,
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: 50,
            }}>
            <Animated.View style={iconStyle}>
              <Ionicons name="mic" size={28} color="white" />
            </Animated.View>
          </LinearGradient>
        </Pressable>
      </Animated.View>
    </View>
  );
}
