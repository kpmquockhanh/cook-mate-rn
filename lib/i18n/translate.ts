import en, { type TranslationKey } from './en';
import vi from './vi';
import { detectDeviceLanguage, type Language } from './languages';
import type { Phrase, TranslationValues } from './phrase';

/**
 * Turning a key into a string, in a given language.
 *
 * There is no React in here on purpose: the API client, the confirm dialogs
 * and the timer alerts all produce user-facing text outside a component, and
 * the alternative - threading a `t` through every call site - would put a
 * translation argument on functions that otherwise take none.
 */

const CATALOGUES: Record<Language, Partial<Record<TranslationKey, Phrase>>> = { en, vi };

/** Replaces `{name}` with the matching value; unknown placeholders stay put. */
function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match
  );
}

/**
 * English is the only language here with plural forms, so `count` of exactly 1
 * takes `one` and everything else - including a missing count - takes `other`.
 * A language that writes one string for both never reaches this.
 */
function selectForm(phrase: Phrase, values?: TranslationValues): string {
  if (typeof phrase === 'string') return phrase;
  return values?.count === 1 ? phrase.one : phrase.other;
}

export function translate(
  language: Language,
  key: TranslationKey,
  values?: TranslationValues
): string {
  // Falling through to English rather than showing the key: a missing
  // translation should read as untranslated, not as broken.
  const phrase = CATALOGUES[language]?.[key] ?? en[key];
  return interpolate(selectForm(phrase, values), values);
}

/**
 * The language the non-React callers translate into. `SettingsProvider` keeps
 * it in step with the stored preference; until that has been read, the device's
 * own language is the best guess available.
 */
let activeLanguage: Language = detectDeviceLanguage();

export function setActiveLanguage(language: Language): void {
  activeLanguage = language;
}

export function getActiveLanguage(): Language {
  return activeLanguage;
}

/** The current language's translation. Components use `useTranslation` instead. */
export function t(key: TranslationKey, values?: TranslationValues): string {
  return translate(activeLanguage, key, values);
}
