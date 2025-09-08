import React from 'react';
import { View, Text } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTimer } from '../../lib/TimerContext';

interface TimerTabIconProps {
  size: number;
  color: string;
  focused: boolean;
}

export default function TimerTabIcon({ size, color, focused }: TimerTabIconProps) {
  const { runningTimersCount, hasActiveTimers } = useTimer();

  return (
    <View style={{ position: 'relative' }}>
      <MaterialIcons size={size} name="timer" color={color} />
      
      {/* Active timer indicator badge - only show when tab is not focused */}
      {hasActiveTimers && !focused && (
        <View
          style={{
            position: 'absolute',
            top: -2,
            right: -6,
            backgroundColor: runningTimersCount > 0 ? '#FF6B6B' : '#4FD1C5', // vibrant coral/teal
            borderRadius: 8,
            minWidth: 16,
            height: 16,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 4,
          }}
        >
          <Text
            style={{
              color: 'white',
              fontSize: 10,
              fontWeight: 'bold',
              textAlign: 'center',
            }}
          >
            {runningTimersCount > 0 ? runningTimersCount : ''}
          </Text>
        </View>
      )}
    </View>
  );
}
