import { BlurView } from 'expo-blur';
import { View } from 'react-native';

// Near-opaque on purpose: at lower opacity, colourful content scrolling under
// the bar (a red button, say) glows through the blur and reads as a hard band.
// The edge is marked with a soft upward shadow instead of a line.
const BAR_COLOR = 'rgba(255, 255, 255, 0.96)';

export default function BlurTabBackground() {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        backgroundColor: BAR_COLOR,
        boxShadow: '0px -6px 20px rgba(17, 24, 39, 0.06)',
      }}>
      <View
        style={{
          flex: 1,
          borderTopLeftRadius: 30,
          borderTopRightRadius: 30,
          overflow: 'hidden',
        }}>
        <BlurView tint="light" intensity={25} style={{ flex: 1, backgroundColor: BAR_COLOR }} />
      </View>
    </View>
  );
}
