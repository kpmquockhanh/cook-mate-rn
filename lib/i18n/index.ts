import { useMemo } from 'react';
import { useSettings } from '../SettingsContext';
import { translate } from './translate';
import type { Language } from './languages';
import type { TranslationKey } from './en';
import type { TranslationValues } from './phrase';

export { translate, t, setActiveLanguage, getActiveLanguage } from './translate';
export {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  isLanguage,
  speechLocaleFor,
  detectDeviceLanguage,
} from './languages';
export type { Language, LanguageOption } from './languages';
export type { Phrase, PluralForms, TranslationValues } from './phrase';
export type { TranslationKey } from './en';

export type Translator = (key: TranslationKey, values?: TranslationValues) => string;

/** The active language on its own, for the few callers that need the tag. */
export function useLanguage(): Language {
  return useSettings().settings.language;
}

/**
 * The hook every component uses.
 *
 * It reads the language out of `SettingsContext`, so changing the preference
 * re-renders each consumer with the new wording - there is no second provider
 * to keep in step, and no way for a screen to be left showing the old language.
 */
export function useTranslation(): { t: Translator; language: Language } {
  const language = useLanguage();
  return useMemo(
    () => ({
      language,
      t: (key: TranslationKey, values?: TranslationValues) => translate(language, key, values),
    }),
    [language]
  );
}
