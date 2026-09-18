/**
 * Everything that decides *when* the agent thinks the user has finished talking,
 * and *which language* it listens and speaks in.
 *
 * These used to be inline defaults in `agent.ts`. They are gathered here because
 * they are the knobs you actually turn when the agent starts talking over the
 * user, replying to its own echo, or mishearing Vietnamese - and because the
 * right value depends on the room (headphones vs. a phone on a kitchen counter),
 * so every one of them is overridable from `.env`.
 */

/**
 * Read an optional setting, rejecting the two values that are never meant
 * literally: blank, and a leftover comment.
 *
 * Docker Compose's `env_file` parser strips an inline `# comment` only when the
 * line already has a value. `KEY=fable  # note` arrives as "fable", but
 * `KEY=  # note` arrives as "# note" - so a commented-out blank in .env reaches
 * the worker as a string that looks deliberate. Sent on to the server that is a
 * 422, and a 422 is not retryable, which closes the whole session over a line
 * the author meant to leave empty.
 */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (value.startsWith('#')) {
    console.warn(
      `[cookmate] Ignoring ${name}: the value is an unstripped comment (${value}). ` +
        'Put comments on their own line in .env, not after an empty value.'
    );
    return undefined;
  }
  return value;
}

/** Same, for a setting that has to parse as a finite number to be usable. */
export function numberEnv(name: string, fallback: number): number {
  const raw = optionalEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[cookmate] Ignoring ${name}: "${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * The spoken language, as a two-letter code. Vietnamese by default - this is a
 * Vietnamese cooking app, and the STT has to be told which language to expect
 * before the first word arrives, so "detect it later" is not an option.
 */
export const LANGUAGE = (optionalEnv('AGENT_LANGUAGE') ?? 'vi').toLowerCase();

/** Human-readable name for the system prompt, so the LLM answers in kind. */
const LANGUAGE_NAMES: Record<string, string> = {
  vi: 'Vietnamese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  th: 'Thai',
};

export const LANGUAGE_NAME = LANGUAGE_NAMES[LANGUAGE] ?? LANGUAGE;

/**
 * Languages the LiveKit audio turn detector (`turn-detector-v1`) was trained on.
 * Mirrors `inference/eot/languages.ts` in @livekit/agents; kept as a literal
 * because that table is not exported in a form we can key off safely.
 *
 * Vietnamese is deliberately absent upstream. Handing the detector an unsupported
 * language is what produced the "running EOU detection / skipping EOU detection"
 * churn in the logs: it wakes on every VAD blip, finds no usable prediction, and
 * drops the turn - so the session never settles on a single utterance.
 */
const TURN_DETECTOR_LANGUAGES = new Set([
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pt',
  'tr',
  'zh',
]);

/**
 * How the end of a turn is decided. `undefined` lets the session auto-provision
 * the semantic detector, which is the better choice when it knows the language.
 * For anything else - Vietnamese included - pin it to plain VAD silence plus the
 * endpointing delay below, which is both more predictable and cheaper than
 * asking a model that has no opinion about the language it is hearing.
 */
export const TURN_DETECTION = (optionalEnv('TURN_DETECTION') ??
  (TURN_DETECTOR_LANGUAGES.has(LANGUAGE) ? undefined : 'vad')) as
  | 'vad'
  | 'stt'
  | 'manual'
  | undefined;

/**
 * VAD tuning.
 *
 * The defaults here are deliberately less twitchy than the library's. A kitchen
 * has running water, a fan, and a phone speaker playing the agent's own voice
 * back into the mic, and each of those opens a "turn" under the stock settings -
 * which is what the START_OF_SPEECH/END_OF_SPEECH storm in the logs was.
 *
 * - `minSpeechDuration` throws away blips shorter than a syllable.
 * - `minSilenceDuration` is the real debounce: a pause inside a sentence no
 *   longer splits it into two utterances, so the LLM is asked once, not four
 *   times. Vietnamese is syllable-timed and speakers pause between syllables
 *   more than the 250ms default assumes, hence the jump to 700ms.
 * - `activationThreshold` is raised so steady background noise stays below it.
 */
export const vadOptions = {
  minSpeechDuration: numberEnv('VAD_MIN_SPEECH_MS', 120),
  minSilenceDuration: numberEnv('VAD_MIN_SILENCE_MS', 700),
  prefixPaddingDuration: numberEnv('VAD_PREFIX_PADDING_MS', 300),
  activationThreshold: numberEnv('VAD_ACTIVATION_THRESHOLD', 0.6),
};

/**
 * Endpointing: how long after the VAD goes quiet the turn is committed.
 *
 * `minDelay` is additive with the VAD silence above, so the user gets roughly
 * `minSilenceDuration + minDelay` of grace to keep talking. `maxDelay` caps the
 * wait when the user is mid-sentence and the detector keeps deferring.
 */
export const endpointingOptions = {
  mode: 'fixed' as const,
  minDelay: numberEnv('ENDPOINTING_MIN_DELAY_MS', 600),
  maxDelay: numberEnv('ENDPOINTING_MAX_DELAY_MS', 4000),
};

/**
 * Interruption: what it takes to cut the agent off mid-sentence.
 *
 * `minWords` is the important one. With the default of 0, *any* audio energy
 * while the agent is speaking counts as an interruption - including the agent's
 * own voice coming back through the speaker, which is why replies were being
 * abandoned with an empty transcript. Requiring real transcribed words means
 * echo and clatter are ignored, and only an actual "dừng lại" stops it.
 */
export const interruptionOptions = {
  minDuration: numberEnv('INTERRUPTION_MIN_DURATION_MS', 700),
  minWords: numberEnv('INTERRUPTION_MIN_WORDS', 2),
  falseInterruptionTimeout: numberEnv('FALSE_INTERRUPTION_TIMEOUT_MS', 2000),
  resumeFalseInterruption: true,
};

/**
 * LiveKit Cloud's noise/echo filter, applied to the *incoming* app audio before
 * VAD or STT see it. Opt-in via `LIVEKIT_NOISE_CANCELLATION=bvc` because it is a
 * Cloud-only feature: enabling it against a self-hosted server does nothing
 * useful, so it should not be a default.
 *
 * `bvc` (background voice cancellation) is the right module for a kitchen -
 * it removes other people's voices too, not just steady noise. Use `nc` for the
 * lighter, speaker-agnostic version.
 */
export function noiseCancellation(): { moduleId: string; options: Record<string, never> } | undefined {
  const moduleId = optionalEnv('LIVEKIT_NOISE_CANCELLATION');
  if (!moduleId) return undefined;
  return { moduleId, options: {} };
}
