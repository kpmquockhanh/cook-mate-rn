/**
 * What the app knows about wake-word detection: start it, stop it, hear about
 * a detection. Nothing here names openWakeWord, ONNX or the Expo module, so the
 * engine can be replaced by writing another adapter, and the cooking screen and
 * LiveKitVoice never change.
 *
 * This file imports no native code. The wiring to the real module lives in
 * `index.ts` / `index.web.ts`, which keeps this file unit-testable under Node.
 */

/** Scores are the classifier's 0-1 output; see tools/wakeword/README.md for how these were chosen. */
export const WAKE_THRESHOLD = 0.5;
/**
 * The detector hears the agent through the speaker without WebRTC's echo
 * cancellation, so while the agent talks we ask for a much surer detection.
 */
export const WAKE_THRESHOLD_WHILE_AGENT_SPEAKS = 0.8;

type Unsubscribe = () => void;

export interface WakeWordDetector {
  /** False on web and when no native module is linked. start() then does nothing. */
  readonly isAvailable: boolean;
  /** Rejects if the models cannot be loaded or capture cannot start. */
  start(threshold: number): Promise<void>;
  stop(): Promise<void>;
  setThreshold(threshold: number): void;
  onDetected(listener: (score: number) => void): Unsubscribe;
  /** The OS took the microphone (a call, Siri). Detection is paused until onResumed. */
  onInterrupted(listener: () => void): Unsubscribe;
  onResumed(listener: () => void): Unsubscribe;
  /** A runtime failure after start() resolved. Detection has stopped. */
  onError(listener: (message: string) => void): Unsubscribe;
}

/** Mirrors the events `modules/wake-word` declares. Kept structural so this file needs no import from it. */
export type WakeWordNativeEvents = {
  onWakeWord: (event: { score: number }) => void;
  onLevel: (event: { rms: number }) => void;
  onInterrupted: () => void;
  onResumed: () => void;
  onError: (event: { message: string }) => void;
};

export interface WakeWordNative {
  start(threshold: number): Promise<void>;
  stop(): Promise<void>;
  setThreshold(threshold: number): void;
  addListener<E extends keyof WakeWordNativeEvents>(
    event: E,
    listener: WakeWordNativeEvents[E]
  ): { remove(): void };
}

export function createOpenWakeWordDetector(native: WakeWordNative): WakeWordDetector {
  const subscribe = <E extends keyof WakeWordNativeEvents>(
    event: E,
    listener: WakeWordNativeEvents[E]
  ): Unsubscribe => {
    const subscription = native.addListener(event, listener);
    return () => subscription.remove();
  };

  return {
    isAvailable: true,
    start: (threshold) => native.start(threshold),
    stop: () => native.stop(),
    setThreshold: (threshold) => native.setThreshold(threshold),
    onDetected: (listener) => subscribe('onWakeWord', ({ score }) => listener(score)),
    onInterrupted: (listener) => subscribe('onInterrupted', listener),
    onResumed: (listener) => subscribe('onResumed', listener),
    onError: (listener) => subscribe('onError', ({ message }) => listener(message)),
  };
}

const noop: Unsubscribe = () => {};

export const unavailableDetector: WakeWordDetector = {
  isAvailable: false,
  start: async () => {},
  stop: async () => {},
  setThreshold: () => {},
  onDetected: () => noop,
  onInterrupted: () => noop,
  onResumed: () => noop,
  onError: () => noop,
};

export function pickDetector(native: WakeWordNative | null): WakeWordDetector {
  return native ? createOpenWakeWordDetector(native) : unavailableDetector;
}
