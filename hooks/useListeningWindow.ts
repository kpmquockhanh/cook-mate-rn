import { useCallback, useEffect, useRef, useState } from 'react';
import {
  INITIAL_WINDOW,
  stepWindow,
  type WindowEffect,
  type WindowEventType,
  type WindowMode,
  type WindowPhase,
} from '../lib/listeningWindow';

/** How often an open window checks its deadline. Closing up to 250 ms late is inaudible. */
const TICK_MS = 250;

/**
 * The React side of lib/listeningWindow: holds the machine's state, stamps
 * events with the time, runs the clock while the window is open, and hands each
 * effect to `perform`. `dispatch` is stable for the component's lifetime.
 */
export function useListeningWindow(mode: WindowMode, perform: (effect: WindowEffect) => void) {
  const stateRef = useRef(INITIAL_WINDOW);
  const [phase, setPhase] = useState<WindowPhase>('idle');

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const performRef = useRef(perform);
  performRef.current = perform;

  const dispatch = useCallback((type: WindowEventType) => {
    const { state, effects } = stepWindow(stateRef.current, { type, now: Date.now() }, modeRef.current);
    stateRef.current = state;
    setPhase(state.phase);
    effects.forEach((effect) => performRef.current(effect));
  }, []);

  useEffect(() => {
    if (phase !== 'open') return;
    const timer = setInterval(() => dispatch('tick'), TICK_MS);
    return () => clearInterval(timer);
  }, [phase, dispatch]);

  return { phase, dispatch };
}
