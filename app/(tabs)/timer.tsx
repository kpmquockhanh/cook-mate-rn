import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Container } from 'components/Container';
import { StatusBar } from 'expo-status-bar';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTimer, ActiveTimer } from '../../lib/TimerContext';

interface QuickStartTimer {
  id: string;
  name: string;
  minutes: number;
  emoji: string;
  color: string;
}

const quickStartTimers: QuickStartTimer[] = [
  { id: '1', name: 'Quick', minutes: 3, emoji: '⚡', color: '#E8F5E8' },
  { id: '2', name: 'Pasta', minutes: 8, emoji: '🍝', color: '#FFF3E0' },
  { id: '3', name: 'Eggs', minutes: 10, emoji: '🥚', color: '#FCE4EC' },
  { id: '4', name: 'Veggies', minutes: 15, emoji: '🥬', color: '#E8F5E8' },
  { id: '5', name: 'Chicken', minutes: 20, emoji: '🍗', color: '#FCE4EC' },
  { id: '6', name: 'Bread', minutes: 30, emoji: '🍞', color: '#FFF3E0' },
];

export default function Timer() {
  const { activeTimers, setActiveTimers, runningTimersCount } = useTimer();
  
  const [customTimerName, setCustomTimerName] = useState('');
  const [customMinutes, setCustomMinutes] = useState(5);

  const startQuickTimer = (quickTimer: QuickStartTimer) => {
    const newTimer: ActiveTimer = {
      id: Date.now().toString(),
      name: quickTimer.name,
      totalSeconds: quickTimer.minutes * 60,
      remainingSeconds: quickTimer.minutes * 60,
      status: 'running',
      priority: 'active',
      emoji: quickTimer.emoji,
    };
    setActiveTimers(prev => [...prev, newTimer]);
  };

  const startCustomTimer = () => {
    console.log('startCustomTimer', {
      customTimerName, customMinutes
    });
    if (customMinutes > 0) {
      const newTimer: ActiveTimer = {
        id: Date.now().toString(),
        name: customTimerName.trim(),
        totalSeconds: customMinutes * 60,
        remainingSeconds: customMinutes * 60,
        status: 'running',
        priority: 'active',
        emoji: '⏰',
      };
      setActiveTimers(prev => [...prev, newTimer]);
      setCustomTimerName('');
      setCustomMinutes(5);
    }
  };

  const toggleTimer = (id: string) => {
    setActiveTimers(prev => prev.map(timer => 
      timer.id === id 
        ? { ...timer, status: timer.status === 'running' ? 'paused' : 'running' }
        : timer
    ));
  };

  const stopTimer = (id: string) => {
    setActiveTimers(prev => prev.filter(timer => timer.id !== id));
  };

  const addTimeToTimer = (id: string, seconds: number) => {
    setActiveTimers(prev => prev.map(timer => 
      timer.id === id 
        ? { 
            ...timer, 
            remainingSeconds: Math.max(0, timer.remainingSeconds + seconds),
            totalSeconds: timer.totalSeconds + Math.max(0, seconds)
          }
        : timer
    ));
  };

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const getTimerProgress = (timer: ActiveTimer) => {
    return (timer.totalSeconds - timer.remainingSeconds) / timer.totalSeconds;
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical': return '#E53E3E';
      case 'warning': return '#F6AD55';
      case 'active': return '#48BB78';
      default: return '#A0AEC0';
    }
  };

  const getPriorityLabel = (priority: string) => {
    switch (priority) {
      case 'critical': return 'CRITICAL';
      case 'warning': return 'WARNING';
      case 'active': return 'ACTIVE';
      default: return 'PAUSED';
    }
  };



  return (
    <>
      <Container>
        <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 100 }}>
          {/* Quick Start Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Quick Start</Text>
              <MaterialIcons name="bolt" size={20} color="#FF6B6B" />
            </View>
            
            <View style={styles.quickStartGrid}>
              {quickStartTimers.map(timer => (
                <TouchableOpacity
                  key={timer.id}
                  style={[styles.quickStartCard, { backgroundColor: timer.color }]}
                  onPress={() => startQuickTimer(timer)}
                >
                  <Text style={styles.quickStartEmoji}>{timer.emoji}</Text>
                  <Text style={styles.quickStartName}>{timer.name}</Text>
                  <Text style={styles.quickStartTime}>{timer.minutes} min</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Custom Timer Section */}
          <View style={[styles.section, {borderWidth: 1, borderColor: '#E2E8F0', borderRadius: 12, padding: 16}]}>
            <View style={styles.customTimerContainer}>
              <TextInput
                style={styles.timerNameInput}
                placeholder="Timer name (e.g., Pasta"
                value={customTimerName}
                onChangeText={setCustomTimerName}
              />
            </View>

            <View style={styles.timeInputContainer}>
              <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, width: '100%'}}>
              <TouchableOpacity
                style={styles.timeButton}
                onPress={() => setCustomMinutes(Math.max(1, customMinutes - 1))}
              >
                <MaterialIcons name="remove" size={24} color="#666" />
              </TouchableOpacity>
              
              <View style={styles.timeDisplay}>
                <Text style={styles.timeText}>{formatTime(customMinutes * 60)}</Text>
                <Text style={styles.timeLabel}>minutes</Text>
              </View>
              
              <TouchableOpacity
                style={styles.timeButton}
                onPress={() => setCustomMinutes(customMinutes + 1)}
              >
                <MaterialIcons name="add" size={24} color="#666" />
              </TouchableOpacity>
              </View>
              
              <TouchableOpacity
                style={styles.startButton}
                onPress={startCustomTimer}
              >
                <MaterialIcons name="play-arrow" size={24} color="white" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Active Timers Section */}
          <View style={styles.section}>
            <View style={styles.activeTimersHeader}>
              <Text style={styles.sectionTitle}>Active Timers</Text>
              <View style={styles.runningIndicator}>
                <View style={styles.runningDot} />
                <Text style={styles.runningText}>{runningTimersCount} Running</Text>
              </View>
            </View>

            {activeTimers.map(timer => (
              <View
                key={timer.id}
                style={[
                  styles.activeTimerCard,
                  { backgroundColor: getPriorityColor(timer.priority) }
                ]}
              >
                <View style={styles.timerHeader}>
                  <View style={styles.timerTitleContainer}>
                    <Text style={styles.timerEmoji}>{timer.emoji}</Text>
                    <Text style={styles.timerName}>{timer.name}</Text>
                  </View>
                  <Text style={styles.priorityLabel}>
                    {getPriorityLabel(timer.priority)}
                  </Text>
                </View>

                <Text style={styles.timerTime}>{formatTime(timer.remainingSeconds)}</Text>

                <View style={styles.progressContainer}>
                  <View style={styles.progressBar}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${getTimerProgress(timer) * 100}%` }
                      ]}
                    />
                  </View>
                </View>

                <View style={styles.timerControls}>
                  <TouchableOpacity
                    style={styles.controlButton}
                    onPress={() => toggleTimer(timer.id)}
                  >
                    <MaterialIcons
                      name={timer.status === 'running' ? 'pause' : 'play-arrow'}
                      size={20}
                      color="white"
                    />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.controlButton}
                    onPress={() => stopTimer(timer.id)}
                  >
                    <MaterialIcons name="stop" size={20} color="white" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.controlButton}
                    onPress={() => addTimeToTimer(timer.id, -60)}
                  >
                    <MaterialIcons name="remove" size={20} color="white" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.controlButton}
                    onPress={() => addTimeToTimer(timer.id, 60)}
                  >
                    <MaterialIcons name="add" size={20} color="white" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.controlButton}
                    onPress={() => stopTimer(timer.id)}
                  >
                    <MaterialIcons name="delete" size={20} color="white" />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      </Container>
      <StatusBar style="auto" />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 50,
  },
  section: {
    marginBottom: 30,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  quickStartGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  quickStartCard: {
    width: '47%',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  quickStartEmoji: {
    fontSize: 24,
    marginBottom: 8,
  },
  quickStartName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  quickStartTime: {
    fontSize: 12,
    color: '#666',
  },
  customTimerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    gap: 12,
  },
  timerNameInput: {
    flex: 1,
    backgroundColor: '#f8f8f8',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#333',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  micButton: {
    backgroundColor: '#5A67D8',
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeInputContainer: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  timeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f8f8f8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeDisplay: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  timeText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#333',
  },
  timeLabel: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  startButton: {
    backgroundColor: '#FF6B6B',
    width: '100%',
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeTimersHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  runningIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  runningDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#48BB78',
  },
  runningText: {
    fontSize: 14,
    color: '#666',
  },
  activeTimerCard: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  timerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  timerTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timerEmoji: {
    fontSize: 20,
  },
  timerName: {
    fontSize: 16,
    fontWeight: '600',
    color: 'white',
  },
  priorityLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: 'white',
    opacity: 0.9,
  },
  timerTime: {
    fontSize: 36,
    fontWeight: 'bold',
    color: 'white',
    marginBottom: 16,
  },
  progressContainer: {
    marginBottom: 20,
  },
  progressBar: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: 'white',
  },
  timerControls: {
    flexDirection: 'row',
    gap: 12,
  },
  controlButton: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTimerButton: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  addTimerText: {
    fontSize: 16,
    color: '#666',
    marginTop: 8,
  },
  addTimerSubtext: {
    fontSize: 14,
    color: '#999',
    marginTop: 4,
  },
});
