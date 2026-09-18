import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useEffect,
  useRef,
} from 'react';
import { Platform, Vibration } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettings } from './SettingsContext';
import { notify } from '../utils/confirm';
import { logger } from './log';
import { t } from './i18n/translate';

const log = logger('timers');

const STORAGE_KEY = 'activeTimers';

export interface ActiveTimer {
  id: string;
  name: string;
  totalSeconds: number;
  remainingSeconds: number;
  status: 'running' | 'paused' | 'stopped';
  priority: 'critical' | 'warning' | 'active';
  emoji: string;
  /**
   * Epoch ms at which a running timer reaches zero.
   *
   * The countdown is derived from this rather than from counting interval
   * ticks: JavaScript timers are throttled or suspended outright while the app
   * is backgrounded, so a tick-counted 20-minute timer comes back minutes slow
   * - exactly when a cook is least able to notice. Undefined while paused, and
   * backfilled on the first tick for timers created without one.
   */
  endsAt?: number;
}

/** How a timer should read, once its remaining time and status are both known. */
export type TimerTone = 'done' | 'critical' | 'warning' | 'active' | 'paused';

/** Under a minute is the point where a cook has to be standing at the pan. */
const CRITICAL_SECONDS = 60;
const WARNING_SECONDS = 5 * 60;

export function timerTone(timer: ActiveTimer): TimerTone {
  if (timer.remainingSeconds <= 0) return 'done';
  if (timer.status !== 'running') return 'paused';
  if (timer.remainingSeconds <= CRITICAL_SECONDS) return 'critical';
  if (timer.remainingSeconds <= WARNING_SECONDS) return 'warning';
  return 'active';
}

/**
 * The stored `priority` field, recomputed. It used to be set once when the
 * timer was created and never touched again, so a timer ten seconds from
 * burning the garlic still described itself as 'active'.
 */
function priorityFor(remainingSeconds: number): ActiveTimer['priority'] {
  if (remainingSeconds <= CRITICAL_SECONDS) return 'critical';
  if (remainingSeconds <= WARNING_SECONDS) return 'warning';
  return 'active';
}

/** "0:45", "12:30", "1:05:00" - hours only once there are any. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/** What a caller has to supply to start a timer; the rest is bookkeeping. */
export interface NewTimer {
  name: string;
  seconds: number;
  emoji?: string;
}

interface TimerContextType {
  activeTimers: ActiveTimer[];
  setActiveTimers: React.Dispatch<React.SetStateAction<ActiveTimer[]>>;
  /** False until storage has been read, so the UI can avoid an empty flash. */
  isLoaded: boolean;
  runningTimersCount: number;
  hasActiveTimers: boolean;
  /** Returns the new timer's id, for callers that want to track it. */
  startTimer: (timer: NewTimer) => string;
  toggleTimer: (id: string) => void;
  /** Adds (or, negative, removes) time. Never takes a timer below zero. */
  addTime: (id: string, seconds: number) => void;
  /** Back to its original duration, running. */
  restartTimer: (id: string) => void;
  dismissTimer: (id: string) => void;
  dismissFinished: () => void;
}

const TimerContext = createContext<TimerContextType | undefined>(undefined);

export const useTimer = () => {
  const context = useContext(TimerContext);
  if (context === undefined) {
    throw new Error('useTimer must be used within a TimerProvider');
  }
  return context;
};

/** A three-pulse pattern, so a finished timer is distinguishable from a nudge. */
const FINISH_VIBRATION = [0, 400, 200, 400, 200, 400];
const WARNING_VIBRATION = 200;

/** Recomputes a running timer's remaining seconds from the wall clock. */
function tick(timer: ActiveTimer, now: number): ActiveTimer {
  if (timer.status !== 'running' || timer.remainingSeconds <= 0) return timer;

  // Created without an end time (the cooking screen builds timers by hand):
  // anchor it now rather than falling back to counting ticks.
  const endsAt = timer.endsAt ?? now + timer.remainingSeconds * 1000;
  const remainingSeconds = Math.max(0, Math.round((endsAt - now) / 1000));

  if (remainingSeconds === timer.remainingSeconds && timer.endsAt === endsAt) return timer;
  return { ...timer, endsAt, remainingSeconds, priority: priorityFor(remainingSeconds) };
}

export const TimerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const { settings } = useSettings();
  // Read through a ref inside the tick: putting `settings` in the effect's
  // dependencies would tear down and restart the interval on every preference
  // change, which shifts every running timer by up to a second.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /**
   * Alerts that have already fired, as `<timer id>:<done|warn>`. A finished
   * timer sits at zero until the user dismisses it, and the pre-alert threshold
   * is visible across several renders, so without this the user would be told
   * about the same timer on every tick.
   */
  const announced = useRef(new Set<string>());

  // Restore timers from the last session. A timer whose end time has passed
  // comes back finished rather than resuming from where the app was closed.
  useEffect(() => {
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const now = Date.now();
          const restored = (JSON.parse(raw) as ActiveTimer[]).map((timer) => tick(timer, now));
          // Timers that ran out while the app was closed are shown as done in
          // the list, but they do not get to open a dialog on launch: the
          // moment has passed and the user did not miss a decision.
          restored.forEach((timer) => {
            if (timer.remainingSeconds <= 0) announced.current.add(`${timer.id}:done`);
          });
          setActiveTimers(restored);
        }
      } catch (error) {
        log.error('Could not restore timers', error);
      } finally {
        setIsLoaded(true);
      }
    };

    load();
  }, []);

  /**
   * What gets written to storage. A running timer's countdown is rebuilt from
   * `endsAt` on the next launch, so the ticking value is left out of the
   * snapshot: with it in, the string changed every second and the app wrote to
   * disk once a second for the length of every cooking session.
   */
  const snapshot = useMemo(
    () =>
      JSON.stringify(
        activeTimers.map((timer) => ({
          ...timer,
          remainingSeconds:
            timer.status === 'running' && timer.endsAt
              ? timer.totalSeconds
              : timer.remainingSeconds,
        }))
      ),
    [activeTimers]
  );

  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY, snapshot).catch((error) =>
      log.error('Could not save timers', error)
    );
  }, [snapshot, isLoaded]);

  // Calculate derived values
  const runningTimersCount = activeTimers.filter(
    (t) => t.status === 'running' && t.remainingSeconds > 0
  ).length;
  const hasActiveTimers = activeTimers.length > 0;

  // The tick only counts down. It used to raise the "finished" dialog from
  // inside the state updater, which is not a place side effects can live: React
  // may run an updater twice, or later than the call that queued it.
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      const now = Date.now();
      setActiveTimers((prev) => {
        const next = prev.map((timer) => tick(timer, now));
        // Returning `prev` when nothing moved keeps a screen full of paused
        // timers from re-rendering once a second.
        return next.some((timer, index) => timer !== prev[index]) ? next : prev;
      });
    }, 250);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  // Alerts are a reaction to committed state rather than part of producing it,
  // which is what keeps the updater above pure.
  useEffect(() => {
    const { timerVibrate, timerAlertDialog, timerPreAlertSeconds } = settingsRef.current;

    const announce = (key: string, timer: ActiveTimer, finished: boolean) => {
      if (announced.current.has(key)) return;
      announced.current.add(key);

      // react-native-web only forwards Vibration where navigator.vibrate
      // exists, and a buzz is not what a desktop browser should answer with.
      if (timerVibrate && Platform.OS !== 'web') {
        Vibration.vibrate(finished ? FINISH_VIBRATION : WARNING_VIBRATION);
      }

      if (!timerAlertDialog) return;

      // `t` rather than the hook: this runs from an effect, and the provider
      // has already pointed it at the stored language.
      const name = timer.name || t('timer.yourTimer');

      if (finished) {
        notify(t('timer.finishedAlertTitle'), t('timer.finishedAlertMessage', { name }));
        return;
      }

      notify(
        t('timer.almostDoneTitle'),
        t('timer.almostDoneMessage', {
          name,
          duration: formatDuration(timer.remainingSeconds),
        })
      );
    };

    activeTimers.forEach((timer) => {
      if (timer.status !== 'running') return;

      if (timer.remainingSeconds <= 0) {
        announce(`${timer.id}:done`, timer, true);
        return;
      }

      // `totalSeconds` guards the case where the timer is shorter than the
      // warning, which would otherwise announce "almost done" on the first tick.
      if (
        timerPreAlertSeconds > 0 &&
        timer.remainingSeconds <= timerPreAlertSeconds &&
        timer.totalSeconds > timerPreAlertSeconds
      ) {
        announce(`${timer.id}:warn`, timer, false);
      }
    });

    // A dismissed timer can come back under a fresh id, but an id that is gone
    // will never alert again - so forget it, rather than letting the set grow
    // for the life of the app.
    if (announced.current.size > 0) {
      const live = new Set(activeTimers.map((timer) => timer.id));
      announced.current.forEach((key) => {
        if (!live.has(key.slice(0, key.lastIndexOf(':')))) announced.current.delete(key);
      });
    }
  }, [activeTimers]);

  const startTimer = useCallback(({ name, seconds, emoji = '⏰' }: NewTimer) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setActiveTimers((prev) => [
      ...prev,
      {
        id,
        name,
        totalSeconds: seconds,
        remainingSeconds: seconds,
        status: 'running',
        priority: priorityFor(seconds),
        emoji,
        endsAt: Date.now() + seconds * 1000,
      },
    ]);
    return id;
  }, []);

  const toggleTimer = useCallback((id: string) => {
    setActiveTimers((prev) =>
      prev.map((timer) => {
        if (timer.id !== id || timer.remainingSeconds <= 0) return timer;

        if (timer.status === 'running') {
          // Drop the end time: while paused, `remainingSeconds` is the truth.
          return { ...timer, status: 'paused', endsAt: undefined };
        }
        return {
          ...timer,
          status: 'running',
          endsAt: Date.now() + timer.remainingSeconds * 1000,
        };
      })
    );
  }, []);

  const addTime = useCallback((id: string, seconds: number) => {
    setActiveTimers((prev) =>
      prev.map((timer) => {
        if (timer.id !== id) return timer;

        const remainingSeconds = Math.max(0, timer.remainingSeconds + seconds);
        // Grow the total alongside it so the progress ring stays honest;
        // shrinking it would make a topped-up timer read as over 100% done.
        const totalSeconds = Math.max(timer.totalSeconds, remainingSeconds);
        // Adding time to a finished timer is how a cook says "a bit longer",
        // so it starts running again rather than sitting at zero.
        const status = remainingSeconds > 0 && timer.status !== 'paused' ? 'running' : timer.status;

        return {
          ...timer,
          remainingSeconds,
          totalSeconds,
          status,
          priority: priorityFor(remainingSeconds),
          endsAt: status === 'running' ? Date.now() + remainingSeconds * 1000 : undefined,
        };
      })
    );
    // The timer is live again, so let it alert again.
    announced.current.delete(`${id}:done`);
    announced.current.delete(`${id}:warn`);
  }, []);

  const restartTimer = useCallback((id: string) => {
    setActiveTimers((prev) =>
      prev.map((timer) =>
        timer.id === id
          ? {
              ...timer,
              remainingSeconds: timer.totalSeconds,
              status: 'running',
              priority: priorityFor(timer.totalSeconds),
              endsAt: Date.now() + timer.totalSeconds * 1000,
            }
          : timer
      )
    );
    announced.current.delete(`${id}:done`);
    announced.current.delete(`${id}:warn`);
  }, []);

  const dismissTimer = useCallback((id: string) => {
    setActiveTimers((prev) => prev.filter((timer) => timer.id !== id));
  }, []);

  const dismissFinished = useCallback(() => {
    setActiveTimers((prev) => prev.filter((timer) => timer.remainingSeconds > 0));
  }, []);

  const value = {
    activeTimers,
    setActiveTimers,
    isLoaded,
    runningTimersCount,
    hasActiveTimers,
    startTimer,
    toggleTimer,
    addTime,
    restartTimer,
    dismissTimer,
    dismissFinished,
  };

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
};
