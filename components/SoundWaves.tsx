import React, { useEffect, useRef } from 'react';
import {
  View,
  Animated,
  StyleSheet,
  Dimensions,
} from 'react-native';

const { width } = Dimensions.get('window');

const SoundWaveAnimator = () => {
  // Number of wave bars
  const numberOfBars = 20;
  const animatedValues = useRef<Animated.Value[]>(
    Array.from({ length: numberOfBars }, () => new Animated.Value(0.1))
  );
  const animations = useRef<Animated.CompositeAnimation[]>([]);

  // Cleanup on unmount: stop animations and reset values
  useEffect(() => {
    // Auto-start bars animation on mount
    startWaveAnimation();

    return () => {
      animations.current.forEach(animation => animation.stop());
      animatedValues.current.forEach(animValue => animValue.stopAnimation());
    };
  }, []);

  // Create staggered wave animation
  const startWaveAnimation = () => {
    // Create individual animations for each bar
    const barAnimations = animatedValues.current.map((animValue, index) => {
      return Animated.loop(
        Animated.sequence([
          Animated.timing(animValue, {
            toValue: Math.random() * 0.8 + 0.2, // Random height between 0.2 and 1
            duration: 150 + Math.random() * 200, // Random duration for natural feel
            useNativeDriver: false,
          }),
          Animated.timing(animValue, {
            toValue: 0.1 + Math.random() * 0.3,
            duration: 150 + Math.random() * 200,
            useNativeDriver: false,
          }),
        ])
      );
    });

    // Store animations reference
    animations.current = barAnimations;

    // Start all animations with slight delays for wave effect
    barAnimations.forEach((animation, index) => {
      setTimeout(() => {
        animation.start();
      }, index * 50); // Stagger the start times
    });
  };

  // Stop/reset not needed for UI; cleanup handled in effect above

  // Render individual wave bar
  const renderWaveBar = (index: number) => {
    const animatedHeight = animatedValues.current[index];

    if (!animatedHeight) return null;
    
    return (
      <Animated.View
        key={index}
        style={[
          styles.waveBar,
          {
            height: animatedHeight.interpolate({
              inputRange: [0, 1],
              outputRange: [4, 18], // Min height 4px, max height 18px
            }),
            backgroundColor: animatedHeight.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: ['#4A90E2', '#7B68EE', '#FF6B6B'], // Color transition
            }),
          },
        ]}
      />
    );
  };

  return (
    <View style={styles.waveContainer}>
      {Array.from({ length: numberOfBars }, (_, index) => renderWaveBar(index))}
    </View>
  );
};

// Main component with only wave bars
const AnimatedSoundWaves = () => {
  return (
    <SoundWaveAnimator />
  );
};

const styles = StyleSheet.create({
  waveContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    height: 20,
    marginBottom: 10,
  },
  waveBar: {
    width: 4,
    marginHorizontal: 2,
    borderRadius: 2,
  },
});

export default AnimatedSoundWaves;