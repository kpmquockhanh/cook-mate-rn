/**
 * The app's environment, validated once instead of discovered one screen at a
 * time. This is the client-side counterpart to backend/src/env.ts.
 *
 * Two things make this different from reading process.env at each call site:
 *
 *   1. Every EXPO_PUBLIC_* reference below is written out in full on purpose.
 *      Expo's Babel plugin inlines these as string literals at build time - it
 *      is a textual substitution, not a real object - so `process.env[name]`
 *      with a computed name resolves to undefined in a build. Do not refactor
 *      these into a loop.
 *   2. A missing variable is reported with every other missing variable, at
 *      startup, naming the file to fix. The previous behaviour was a non-null
 *      assertion in lib/supabase.ts that turned a blank .env into an opaque
 *      failure deep inside a request.
 *
 * Nothing secret belongs here: EXPO_PUBLIC_* values ship inside the JS bundle
 * and are readable by anyone with the app. RLS is what guards the data.
 */

const raw = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
  storageUrl: process.env.EXPO_PUBLIC_STORAGE_URL,
  devEmail: process.env.EXPO_PUBLIC_DEV_EMAIL,
  devPassword: process.env.EXPO_PUBLIC_DEV_PASSWORD,
} as const;

/** The variables the app cannot start without, paired with their env names. */
const REQUIRED = {
  supabaseUrl: 'EXPO_PUBLIC_SUPABASE_URL',
  supabasePublishableKey: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  apiUrl: 'EXPO_PUBLIC_API_URL',
  storageUrl: 'EXPO_PUBLIC_STORAGE_URL',
} as const;

const missing = (Object.keys(REQUIRED) as (keyof typeof REQUIRED)[])
  .filter((key) => !raw[key])
  .map((key) => REQUIRED[key]);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment ${missing.length === 1 ? 'variable' : 'variables'}: ` +
      `${missing.join(', ')}. Copy .env.example to .env and fill ${missing.length === 1 ? 'it' : 'them'} in ` +
      `(or run \`npm run setup\`), then restart the dev server - Expo inlines these at build time, ` +
      `so an already-running bundler will not pick up the change.`,
  );
}

/** Trailing slashes are stripped so callers can always join with a leading '/'. */
const trimSlash = (value: string) => value.replace(/\/$/, '');

export const env = {
  supabaseUrl: raw.supabaseUrl as string,
  supabasePublishableKey: raw.supabasePublishableKey as string,
  apiUrl: trimSlash(raw.apiUrl as string),
  storageUrl: trimSlash(raw.storageUrl as string),

  // Dev-only sign-in prefill. Read through __DEV__ at the use site as well, so
  // a value left in .env cannot reach a release build.
  devEmail: raw.devEmail ?? '',
  devPassword: raw.devPassword ?? '',
} as const;
