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
import { setActiveLanguage } from './i18n/translate';
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  migrate,
  sanitize,
  type StoredSettings,
  type UserSettings,
} from './settingsSchema';

export {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  SPEECH_RATE_RANGE,
  SERVINGS_RANGE,
  PRE_ALERT_CHOICES,
  WAKE_WINDOW_CHOICES,
  type UserSettings,
} from './settingsSchema';

const log = logger('settings');

const STORAGE_KEY = 'userSettings';

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
