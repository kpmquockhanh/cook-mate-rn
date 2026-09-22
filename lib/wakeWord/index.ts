import WakeWord from '../../modules/wake-word';
import { pickDetector } from './WakeWordDetector';

export {
  WAKE_THRESHOLD,
  WAKE_THRESHOLD_WHILE_AGENT_SPEAKS,
  type WakeWordDetector,
} from './WakeWordDetector';

/** The native module when this build has it; otherwise the inert detector, and the mic tap. */
export const wakeWordDetector = pickDetector(WakeWord);
