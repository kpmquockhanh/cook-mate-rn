/**
 * The languages the app ships with, and how it guesses one on a first launch.
 *
 * Kept apart from the catalogues and from `translate.ts` so that
 * `SettingsContext` - which stores the user's choice - can depend on the type
 * without pulling the React hook in, which would import `SettingsContext` back.
 */

export type Language = 'en' | 'vi';

export interface LanguageOption {
  code: Language;
  /**
   * The language's own name for itself. Deliberately not translated: a picker
   * is read by someone looking for their language, not for ours.
   */
  label: string;
  /** BCP 47 tag, handed to expo-speech so spoken steps get the right voice. */
  speechLocale: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', label: 'English', speechLocale: 'en-US' },
  { code: 'vi', label: 'Tiếng Việt', speechLocale: 'vi-VN' },
] as const;

export const DEFAULT_LANGUAGE: Language = 'en';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

export function speechLocaleFor(language: Language): string {
  return LANGUAGES.find((option) => option.code === language)?.speechLocale ?? 'en-US';
}

/**
 * The device's language, when the app knows it.
 *
 * `Intl` is the one source that answers on iOS, Android and web alike (Hermes
 * ships with it), so this needs no native module and no extra dependency. Any
 * locale that is not one of ours - which is most of them - falls back to
 * English, and the user can still pick from Settings.
 */
export function detectDeviceLanguage(): Language {
  try {
    const locale =
      typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language
        : Intl.DateTimeFormat().resolvedOptions().locale;

    // "vi", "vi-VN" and "vi_VN" all mean Vietnamese; only the part before the
    // separator identifies the language.
    const base = String(locale).toLowerCase().split(/[-_]/)[0];
    return isLanguage(base) ? base : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}
