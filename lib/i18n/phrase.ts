/**
 * What one entry in a catalogue may be.
 *
 * Its own file so `en.ts` (which the other modules read the key list from) has
 * nothing behind it but a type.
 */

/**
 * The two English plural forms. A language that does not inflect - Vietnamese
 * among them - writes a plain string instead, so its catalogue never has to
 * repeat the same sentence twice.
 */
export interface PluralForms {
  one: string;
  other: string;
}

export type Phrase = string | PluralForms;

/** Values substituted into a phrase's `{named}` placeholders. */
export type TranslationValues = Record<string, string | number>;
