import { BlurView } from 'expo-blur';
import { View } from 'react-native';

export default function BlurTabBackground() {
  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        overflow: 'hidden',
      }}
    >
      <BlurView 
        tint="light" 
        intensity={25} 
        style={{
          flex: 1,
          backgroundColor: 'rgba(255, 255, 255, 0.75)', // Fallback background
        }}
      />
    </View>
  );
}
