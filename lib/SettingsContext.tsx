import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './log';
import { detectDeviceLanguage, isLanguage, type Language } from './i18n/languages';
import { setActiveLanguage } from './i18n/translate';

const log = logger('settings');

const STORAGE_KEY = 'userSettings';

/**
 * Bumped whenever a stored blob can no longer be merged over the defaults
 * as-is. Settings are local-only, so there is no server to reconcile with and
 * nothing to fall back on: a shape change that is not handled here reaches the
 * screens as a value of the wrong type. `migrate` below is the single place
 * that turns an older blob into a current one.
 */
export const SETTINGS_SCHEMA_VERSION = 1;

export interface UserSettings {
  // --- Language ------------------------------------------------------------
  /**
   * The app's own wording. Defaults to the device's language when it is one we
   * ship, so a Vietnamese phone opens the app in Vietnamese without being asked.
   */
  language: Language;

  // --- Cooking -------------------------------------------------------------
  /**
   * Household size the recipe screen scales to on open. `null` means "use
   * whatever the recipe was written for", which is what the app did before
   * this setting existed.
   */
  defaultServings: number | null;
  /** Hold the screen on for the whole cooking session. */
  keepScreenAwake: boolean;
  /** Raise the app's brightness while cooking, for a screen across the room. */
  boostBrightness: boolean;

  // --- Voice assistant -----------------------------------------------------
  /**
   * Off means the cooking screen never mints a LiveKit token, so there is no
   * connection attempt and no failure banner for users who cook by tapping.
   */
  voiceEnabled: boolean;
  /** Connect on entering cooking mode rather than waiting for a mic tap. */
  voiceAutoStart: boolean;
  /**
   * Read each step aloud with the device's own speech synthesiser. This is the
   * fallback for when the LiveKit agent is not reachable, so it is deliberately
   * independent of `voiceEnabled`; the cooking screen suppresses it while the
   * agent is connected so the two are never talking over each other.
   */
  spokenSteps: boolean;
  /** Rate passed to expo-speech. 1 is the platform's normal speed. */
  speechRate: number;

  // --- Timers --------------------------------------------------------------
  timerVibrate: boolean;
  /** The blocking "Timer Finished!" dialog. */
  timerAlertDialog: boolean;
  /** Warn this many seconds before a timer ends. 0 disables the warning. */
  timerPreAlertSeconds: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  language: detectDeviceLanguage(),
  defaultServings: null,
  keepScreenAwake: true,
  boostBrightness: false,
  voiceEnabled: true,
  voiceAutoStart: false,
  spokenSteps: false,
  speechRate: 1,
  timerVibrate: true,
  timerAlertDialog: true,
  timerPreAlertSeconds: 0,
};

/** Values offered by the screen, and the range `sanitize` will accept. */
export const SPEECH_RATE_RANGE = { min: 0.5, max: 1.5 } as const;
export const SERVINGS_RANGE = { min: 1, max: 12 } as const;
export const PRE_ALERT_CHOICES = [0, 30, 60, 120, 300] as const;

interface StoredSettings extends Partial<UserSettings> {
  schemaVersion?: number;
}

/**
 * Brings an older stored blob up to the current shape. Version 1 is the first,
 * so there is nothing to do yet - the function exists so the next change has an
 * obvious home and `load` never has to grow a second place that knows about
 * versions.
 */
function migrate(stored: StoredSettings): StoredSettings {
  return stored;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merges a stored blob over the defaults, dropping anything of the wrong type
 * and clamping the numbers. Storage is writable by nothing but this file, but
 * it outlives the code that wrote it: a value removed from a union or a range
 * that narrows would otherwise resurface as a rate of 9 or a negative serving
 * count long after the release that allowed it.
 */
function sanitize(stored: StoredSettings): UserSettings {
  const bool = (value: unknown, fallback: boolean) =>
    typeof value === 'boolean' ? value : fallback;

  const servings = stored.defaultServings;
  const preAlert = stored.timerPreAlertSeconds;

  return {
    language: isLanguage(stored.language) ? stored.language : DEFAULT_SETTINGS.language,
    defaultServings:
      typeof servings === 'number' && Number.isFinite(servings)
        ? Math.round(clamp(servings, SERVINGS_RANGE.min, SERVINGS_RANGE.max))
        : null,
    keepScreenAwake: bool(stored.keepScreenAwake, DEFAULT_SETTINGS.keepScreenAwake),
    boostBrightness: bool(stored.boostBrightness, DEFAULT_SETTINGS.boostBrightness),
    voiceEnabled: bool(stored.voiceEnabled, DEFAULT_SETTINGS.voiceEnabled),
    voiceAutoStart: bool(stored.voiceAutoStart, DEFAULT_SETTINGS.voiceAutoStart),
    spokenSteps: bool(stored.spokenSteps, DEFAULT_SETTINGS.spokenSteps),
    speechRate:
      typeof stored.speechRate === 'number' && Number.isFinite(stored.speechRate)
        ? clamp(stored.speechRate, SPEECH_RATE_RANGE.min, SPEECH_RATE_RANGE.max)
        : DEFAULT_SETTINGS.speechRate,
    timerVibrate: bool(stored.timerVibrate, DEFAULT_SETTINGS.timerVibrate),
    timerAlertDialog: bool(stored.timerAlertDialog, DEFAULT_SETTINGS.timerAlertDialog),
    timerPreAlertSeconds: PRE_ALERT_CHOICES.includes(preAlert as (typeof PRE_ALERT_CHOICES)[number])
      ? (preAlert as number)
      : DEFAULT_SETTINGS.timerPreAlertSeconds,
  };
}

interface SettingsContextType {
  settings: UserSettings;
  /**
   * False until storage has been read. Consumers that act on a setting once
   * (the recipe screen's default servings) must wait for it, or they will act
   * on the defaults and then see the stored value arrive a frame later.
   */
  isLoaded: boolean;
  updateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // Mirrors `isLoaded` for `updateSetting`, which must not write before the
  // read has finished or it would persist the defaults over the user's stored
  // values. It is set with the state, not during render.
  const loadedRef = useRef(false);

  // Mirrors the choice into the translation module, for the callers that cannot
  // use the hook: the API client, the confirm dialogs, the timer alerts. They
  // all produce their text from a callback rather than during render, so
  // syncing after the commit is soon enough.
  useEffect(() => {
    setActiveLanguage(settings.language);
  }, [settings.language]);

  useEffect(() => {
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          setSettings(sanitize(migrate(JSON.parse(raw) as StoredSettings)));
        }
      } catch (error) {
        // A corrupt blob is not worth blocking the app over: the defaults are
        // a working app, and the next write replaces what could not be read.
        log.error('Could not read stored settings; falling back to defaults', error);
      } finally {
        loadedRef.current = true;
        setIsLoaded(true);
      }
    };

    load();
  }, []);

  // Persisting from the setter rather than an effect on `settings` keeps the
  // load from writing straight back what it just read, and means a write only
  // ever happens because the user changed something.
  const persist = useCallback((next: UserSettings) => {
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...next, schemaVersion: SETTINGS_SCHEMA_VERSION })
    ).catch((error) => log.error('Could not save settings', error));
  }, []);

  const updateSetting = useCallback(
    <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
      if (!loadedRef.current) return;
      setSettings((current) => {
        const next = sanitize({ ...current, [key]: value });
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    persist(DEFAULT_SETTINGS);
  }, [persist]);

  return (
    <SettingsContext.Provider value={{ settings, isLoaded, updateSetting, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
