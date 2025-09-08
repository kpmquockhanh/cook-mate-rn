import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { Alert } from 'react-native';

export interface ActiveTimer {
  id: string;
  name: string;
  totalSeconds: number;
  remainingSeconds: number;
  status: 'running' | 'paused' | 'stopped';
  priority: 'critical' | 'warning' | 'active';
  emoji: string;
}

interface TimerContextType {
  activeTimers: ActiveTimer[];
  setActiveTimers: React.Dispatch<React.SetStateAction<ActiveTimer[]>>;
  runningTimersCount: number;
  hasActiveTimers: boolean;
}

const TimerContext = createContext<TimerContextType | undefined>(undefined);

export const useTimer = () => {
  const context = useContext(TimerContext);
  if (context === undefined) {
    throw new Error('useTimer must be used within a TimerProvider');
  }
  return context;
};

export const TimerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([
  
  ]);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Calculate derived values
  const runningTimersCount = activeTimers.filter(t => t.status === 'running').length;
  const hasActiveTimers = activeTimers.length > 0;

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setActiveTimers(prev => prev.map(timer => {
        if (timer.status === 'running' && timer.remainingSeconds > 0) {
          const newRemaining = timer.remainingSeconds - 1;
          if (newRemaining === 0) {
            // Timer finished - could trigger notification here
            Alert.alert('Timer Finished!', `${timer.name} is done!`);
          }
          return { ...timer, remainingSeconds: Math.max(0, newRemaining) };
        }
        return timer;
      }));
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const value = {
    activeTimers,
    setActiveTimers,
    runningTimersCount,
    hasActiveTimers,
  };

  return (
    <TimerContext.Provider value={value}>
      {children}
    </TimerContext.Provider>
  );
};
