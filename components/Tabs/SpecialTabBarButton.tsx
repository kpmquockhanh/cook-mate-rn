import { Ionicons } from '@expo/vector-icons';
import { TouchableOpacity, Platform, View, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRef } from 'react';

export default function SpecialTabBarButton() {
  
  // Animation values for wave effect
  const wave1Scale = useRef(new Animated.Value(0)).current;
  const wave1Opacity = useRef(new Animated.Value(0)).current;
  const wave2Scale = useRef(new Animated.Value(0)).current;
  const wave2Opacity = useRef(new Animated.Value(0)).current;
  const wave3Scale = useRef(new Animated.Value(0)).current;
  const wave3Opacity = useRef(new Animated.Value(0)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;

  const startWaveAnimation = () => {
    // Reset all animations
    wave1Scale.setValue(0);
    wave1Opacity.setValue(0.8);
    wave2Scale.setValue(0);
    wave2Opacity.setValue(0.6);
    wave3Scale.setValue(0);
    wave3Opacity.setValue(0.4);

    // Start wave animations with staggered timing
    Animated.parallel([
      // First wave
      Animated.timing(wave1Scale, {
        toValue: 2,
        duration: 800,
        useNativeDriver: true,
      }),
      Animated.timing(wave1Opacity, {
        toValue: 0,
        duration: 800,
        useNativeDriver: true,
      }),
      // Second wave (delayed)
      Animated.sequence([
        Animated.delay(150),
        Animated.parallel([
          Animated.timing(wave2Scale, {
            toValue: 2.2,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(wave2Opacity, {
            toValue: 0,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      ]),
      // Third wave (more delayed)
      Animated.sequence([
        Animated.delay(300),
        Animated.parallel([
          Animated.timing(wave3Scale, {
            toValue: 2.4,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(wave3Opacity, {
            toValue: 0,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      ]),
    ]).start();
  };

  const handlePressIn = () => {
    startWaveAnimation();
    
    // Button scale down animation
    Animated.spring(buttonScale, {
      toValue: 0.95,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    // Button scale back to normal
    Animated.spring(buttonScale, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  };
  return (
    <View
      style={{
        borderRadius: 50,
        margin: 'auto',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        top: -20,
        width: 64,
        height: 64,
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
      {/* Wave animation rings */}
      <Animated.View
        style={{
          position: 'absolute',
          width: 64,
          height: 64,
          borderRadius: 32,
          borderWidth: 2,
          borderColor: '#FF6B6B',
          transform: [{ scale: wave1Scale }],
          opacity: wave1Opacity,
        }}
      />
      <Animated.View
        style={{
          position: 'absolute',
          width: 64,
          height: 64,
          borderRadius: 32,
          borderWidth: 2,
          borderColor: '#FF8E53',
          transform: [{ scale: wave2Scale }],
          opacity: wave2Opacity,
        }}
      />
      <Animated.View
        style={{
          position: 'absolute',
          width: 64,
          height: 64,
          borderRadius: 32,
          borderWidth: 2,
          borderColor: '#FF6B6B',
          transform: [{ scale: wave3Scale }],
          opacity: wave3Opacity,
        }}
      />
      
      {/* Main button with scale animation */}
      <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
        <TouchableOpacity onPressIn={handlePressIn} onPressOut={handlePressOut}>
          <LinearGradient
            colors={['#FF6B6B', '#FF8E53']}
            start={{ x: 0.5, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{
              width: 64,
              height: 64,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: 50,
            }}>
            <Ionicons name="mic" size={28} color="white" />
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}
