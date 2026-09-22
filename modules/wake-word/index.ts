import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core';

/**
 * On-device "Hey CookMate" detection. Knows nothing about LiveKit or the UI:
 * the app reaches it only through lib/wakeWord, which is where the rules live.
 */
export type WakeWordNativeEvents = {
  onWakeWord: (event: { score: number }) => void;
  /** Debug only: RMS of recent capture, about 4 times a second. */
  onLevel: (event: { rms: number }) => void;
  onInterrupted: () => void;
  onResumed: () => void;
  onError: (event: { message: string }) => void;
};

declare class WakeWordNativeModule extends NativeModule<WakeWordNativeEvents> {
  start(threshold: number): Promise<void>;
  stop(): Promise<void>;
  setThreshold(threshold: number): void;
  /** Development only: the max score over a 16 kHz mono WAV at a local path or file:// URI. */
  scoreWav(path: string): Promise<number>;
}

export type { WakeWordNativeModule };

/** Null when the module is not linked (web, or a build made before it existed). */
export default requireOptionalNativeModule<WakeWordNativeModule>('WakeWord');
