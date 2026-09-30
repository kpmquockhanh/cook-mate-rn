import type { TranslationKey } from './i18n/en';

/**
 * Clerk error codes the sign-in screen can say something useful about, in the
 * user's language. Anything else falls back to Clerk's own (English) message.
 */
const KEY_FOR_CODE: Record<string, TranslationKey> = {
  form_password_incorrect: 'auth.errorPasswordIncorrect',
  form_identifier_not_found: 'auth.errorAccountNotFound',
  form_identifier_exists: 'auth.errorEmailTaken',
  form_password_pwned: 'auth.errorPasswordPwned',
  form_password_length_too_short: 'auth.errorPasswordTooShort',
  form_code_incorrect: 'auth.errorCodeIncorrect',
  verification_failed: 'auth.errorCodeIncorrect',
  verification_expired: 'auth.errorCodeExpired',
  too_many_requests: 'auth.errorTooManyAttempts',
};

export type AuthErrorMessage = { key: TranslationKey } | { text: string };

interface ApiErrorLike {
  code?: unknown;
  message?: unknown;
  longMessage?: unknown;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/**
 * Turns whatever a Clerk call returned or threw into something to show. Duck-typed
 * on purpose: Clerk's error classes differ between a ClerkAPIResponseError (the
 * detail is in `errors[0]`) and a ClerkError (the detail is on the object).
 */
export function describeClerkError(error: unknown): AuthErrorMessage {
  if (!error || typeof error !== 'object') return { key: 'auth.errorGeneric' };

  const outer = error as ApiErrorLike & { errors?: unknown };
  const first = Array.isArray(outer.errors) ? (outer.errors[0] as ApiErrorLike | undefined) : undefined;

  for (const code of [str(first?.code), str(outer.code)]) {
    if (code && KEY_FOR_CODE[code]) return { key: KEY_FOR_CODE[code] };
  }

  const text =
    str(first?.longMessage) ?? str(first?.message) ?? str(outer.longMessage) ?? str(outer.message);
  return text ? { text } : { key: 'auth.errorGeneric' };
}
