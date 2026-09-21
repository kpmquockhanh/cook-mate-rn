/**
 * The shape of the stored settings, and the two functions that turn whatever is
 * in storage into it. Kept apart from the provider so it can be unit tested
 * without React or AsyncStorage.
 */
import { detectDeviceLanguage, isLanguage, type Language } from './i18n/languages';
import type { WindowMode } from './listeningWindow';

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
  /**
   * Connect on entering cooking mode and wait for "Hey CookMate", rather than
   * waiting for a mic tap. The microphone stays muted either way until the
   * wake word or a tap opens a listening window.
   */
  voiceAutoStart: boolean;
  /**
   * How long a listening window stays open after the wake word: 'quick' for a
   * request and a follow-up, 'conversation' for a back-and-forth that ends on
   * a long silence or when the user says they are done.
   */
  voiceWakeWindow: WindowMode;
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
  voiceWakeWindow: 'quick',
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
export const WAKE_WINDOW_CHOICES: readonly WindowMode[] = ['quick', 'conversation'] as const;

export interface StoredSettings extends Partial<UserSettings> {
  schemaVersion?: number;
}

/**
 * Brings an older stored blob up to the current shape. Version 1 is the first,
 * so there is nothing to do yet - the function exists so the next change has an
 * obvious home and `load` never has to grow a second place that knows about
 * versions. Additive fields such as `voiceWakeWindow` need nothing here:
 * `sanitize` fills them from the defaults.
 */
export function migrate(stored: StoredSettings): StoredSettings {
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
export function sanitize(stored: StoredSettings): UserSettings {
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
    voiceWakeWindow: WAKE_WINDOW_CHOICES.includes(stored.voiceWakeWindow as WindowMode)
      ? (stored.voiceWakeWindow as WindowMode)
      : DEFAULT_SETTINGS.voiceWakeWindow,
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
