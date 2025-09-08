import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { Slot } from 'expo-router';

export default function App({ children }: { children: React.ReactNode }) {
  return (
    <BottomSheet snapPoints={['75%', '90%']} index={1}>
      <BottomSheetView>
        {children}
      </BottomSheetView>
    </BottomSheet>
  );
}
