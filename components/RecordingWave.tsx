import React, { useEffect, useMemo, useRef , useCallback, useState } from 'react';
import { Animated, Easing, StyleProp, View, ViewStyle } from 'react-native';

// ----------------------------
// Optional: Audio level hook (Expo AV)
// ----------------------------
// Usage:
// const { level, recording, start, stop } = useRecorderLevel();
// <RecordingWave level={level} active={!!recording} />

// import { Audio } from 'expo-av';

/**
 * RecordingWave
 * A lightweight, dependency-free animated "recording" waveform / equalizer for React Native.
 *
 * Two modes:
 * 1) Self-animated (default): pretty looping bars.
 * 2) Audio-driven: pass `level` (0..1) to reflect input loudness.
 *
 * Optional: pair with the `useRecorderLevel` hook below (Expo AV) to drive it from mic input.
 */
export type RecordingWaveProps = {
  /** Number of bars */
  bars?: number;
  /** Overall width/height of the wave container */
  width?: number;
  height?: number;
  /** Bar color */
  color?: string;
  /** Rounded corners on bars */
  radius?: number;
  /** Spacing between bars */
  gap?: number;
  /** If false, animation is paused */
  active?: boolean;
  /** Drive heights from an external level (0..1). If undefined, uses self animation. */
  level?: number;
  /** Optional style for the container */
  style?: StyleProp<ViewStyle>;
  /** Animation speed multiplier (1 = normal) */
  speed?: number;
  /** Minimum bar height as a fraction of container height (0..1) */
  minFraction?: number;
};

export const RecordingWave: React.FC<RecordingWaveProps> = ({
  bars = 24,
  width = 240,
  height = 48,
  color = '#4F46E5', // indigo-600
  radius = 6,
  gap = 4,
  active = true,
  level,
  style,
  speed = 1,
  minFraction = 0.08,
}) => {
  const values = useMemo(() => Array.from({ length: bars }, () => new Animated.Value(0)), [bars]);
  const timers = useRef<NodeJS.Timeout[]>([]);

  // Helper: animate a single bar to a target fraction of height.
  const animateTo = (idx: number, frac: number, dur: number) => {
    Animated.timing(values[idx], {
      toValue: Math.max(minFraction, Math.min(1, frac)),
      duration: Math.max(80, dur),
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: false,
    }).start();
  };

  // Looping animation when no external level is supplied
  useEffect(() => {
    if (!active) return;
    if (typeof level === 'number') return; // audio-driven mode handled in separate effect

    // Clear any previous timers
    timers.current.forEach(clearInterval);
    timers.current = [];

    // Staggered intervals per bar for a lively feel
    values.forEach((_, idx) => {
      const interval = setInterval(() => {
        const base = 0.35 + 0.15 * Math.sin((Date.now() / 400 + idx) % (2 * Math.PI));
        const jitter = (Math.random() * 0.5 - 0.25) * 0.3; // subtle randomness
        const next = Math.max(minFraction, Math.min(1, base + jitter));
        const duration = 220 + ((idx * 23) % 120);
        animateTo(idx, next, duration / speed);
      }, 160 + ((idx * 17) % 140));
      timers.current.push(interval);
    });

    return () => {
      timers.current.forEach(clearInterval);
      timers.current = [];
    };
  }, [active, level, minFraction, speed, values]);

  // Audio-driven mode: map level (0..1) to a smooth target for each bar
  useEffect(() => {
    if (!active) return;
    if (typeof level !== 'number') return;
    const now = Date.now();
    values.forEach((_, idx) => {
      // Make center bars taller, edges shorter (nice bell curve)
      const t = idx / (values.length - 1 || 1); // 0..1
      const bell = Math.exp(-4 * Math.pow(t - 0.5, 2)); // 0..1
      const target = Math.max(minFraction, level * (0.4 + 0.6 * bell));
      const duration = 90 + ((idx * 11 + (now % 50)) % 120);
      animateTo(idx, target, duration / speed);
    });
  }, [level, active, minFraction, speed, values]);

  const barWidth = useMemo(() => {
    const totalGap = gap * (bars - 1);
    return (width - totalGap) / bars;
  }, [bars, gap, width]);

  return (
    <View style={[{ width, height, overflow: 'hidden', justifyContent: 'center' }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {values.map((v, idx) => {
          const h = v.interpolate({
            inputRange: [0, 1],
            outputRange: [height * minFraction, height],
            extrapolate: 'clamp',
          });
          return (
            <Animated.View
              key={idx}
              style={{
                width: barWidth,
                height: h,
                backgroundColor: color,
                borderRadius: radius,
                marginRight: idx === values.length - 1 ? 0 : gap,
              }}
            />
          );
        })}
      </View>
    </View>
  );
};

export function useRecorderLevel(updateMs: number = 120) {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [level, setLevel] = useState(0);

  const start = useCallback(async () => {
    // Ask permissions & configure
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) throw new Error('Microphone permission denied');

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    });

    const rec = new Audio.Recording();
    // Enable metering (iOS supports metering; Android support depends on OS/device)
    await rec.prepareToRecordAsync({
      android: {
        extension: '.m4a',
        outputFormat: Audio.AndroidOutputFormat.MPEG_4,
        audioEncoder: Audio.AndroidAudioEncoder.AAC,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitRate: 128000,
      },
      ios: {
        extension: '.m4a',
        outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
        audioQuality: Audio.IOSAudioQuality.Medium,
        sampleRate: 44100,
        numberOfChannels: 1,
        bitRate: 128000,
        meteringEnabled: true,
      },
      isMeteringEnabled: true as any, // for type compat (Expo SDKs vary)
    } as any);

    await rec.startAsync();
    setRecording(rec);

    // Poll metering
    const id = setInterval(async () => {
      try {
        const status = await rec.getStatusAsync();
        // `metering` is in dBFS (~ -160..0). Map to 0..1.
        const db = (status as any).metering ?? (status as any).meteringEnabled ? (status as any).metering : -160;
        const norm = dbToLinear(db);
        setLevel(norm);
      } catch {}
    }, updateMs);

    // Stop polling when unmounted or stopped
    (rec as any)._levelInterval = id;
  }, [updateMs]);

  const stop = useCallback(async () => {
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
    } catch {}
    const id = (recording as any)._levelInterval;
    if (id) clearInterval(id);
    setRecording(null);
    setLevel(0);
  }, [recording]);

  return { level, recording, start, stop } as const;
}

function dbToLinear(db: number) {
  // Clamp and map -80..0 dB to 0..1 (ignore very low noise floor)
  const clamped = Math.max(-80, Math.min(0, db));
  const lin = Math.pow(10, clamped / 20); // convert dBFS to linear amplitude
  const norm = (lin - Math.pow(10, -80 / 20)) / (1 - Math.pow(10, -80 / 20));
  return Math.max(0, Math.min(1, norm));
}

// ----------------------------
// Example usage (in a screen/component)
// ----------------------------
// import React from 'react';
// import { View, Button } from 'react-native';
// import { RecordingWave, useRecorderLevel } from './RecordingWave';
//
// export default function RecordScreen() {
//   const { level, recording, start, stop } = useRecorderLevel();
//
//   return (
//     <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
//       <RecordingWave width={280} height={56} color="#10B981" level={level} active={!!recording} />
//       <View style={{ height: 16 }} />
//       <Button title={recording ? 'Stop' : 'Start'} onPress={recording ? stop : start} />
//     </View>
//   );
// }
