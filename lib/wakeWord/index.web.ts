import { unavailableDetector } from './WakeWordDetector';

export {
  WAKE_THRESHOLD,
  WAKE_THRESHOLD_WHILE_AGENT_SPEAKS,
  type WakeWordDetector,
} from './WakeWordDetector';

/** Browsers get tap-to-talk only; the native module is never bundled for web. */
export const wakeWordDetector = unavailableDetector;
