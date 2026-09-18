import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

/**
 * The circular countdown behind a timer's remaining time.
 *
 * A ring rather than the bar this screen used to draw: a bar answers "how far
 * through am I", which is the wrong question for a cook. A ring closing on
 * empty is read at a glance from across the kitchen, which is the distance this
 * screen is actually used from.
 */
export default function TimerRing({
  size,
  strokeWidth = 8,
  /** 0 at the start, 1 when the timer has run out. */
  progress,
  color,
  /** Second colour for the sweep. Defaults to a flat `color`. */
  colorEnd,
  trackColor = 'rgba(0,0,0,0.06)',
  children,
}: {
  size: number;
  strokeWidth?: number;
  progress: number;
  color: string;
  colorEnd?: string;
  trackColor?: string;
  children?: React.ReactNode;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, progress));
  // Drawn as a dash the length of the remaining arc, so the ring empties
  // clockwise as the time goes.
  const remaining = circumference * (1 - clamped);

  // Unique per instance: two <Defs> sharing an id on web makes the second ring
  // pick up the first one's colours. `useId` produces ":r0:"-style values, and
  // the colons are not legal in the `url(#...)` reference, so they are stripped.
  const gradientId = `timerRing${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color} />
            <Stop offset="1" stopColor={colorEnd ?? color} />
          </LinearGradient>
        </Defs>

        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference - remaining}
          // Start the arc at twelve o'clock instead of three.
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>

      {children}
    </View>
  );
}
