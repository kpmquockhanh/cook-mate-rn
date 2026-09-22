import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { logger } from './log';

const log = logger('chimes');

export type Chime = 'open' | 'close';

const SOURCES: Record<Chime, number> = {
  open: require('../assets/sounds/wake-open.wav'),
  close: require('../assets/sounds/wake-close.wav'),
};

const players: Partial<Record<Chime, AudioPlayer>> = {};

/**
 * The listening window's sounds: you can tell whether it heard you without
 * looking at a phone across the kitchen.
 *
 * The audio mode is deliberately never set here. LiveKit owns the audio session
 * while a room is up, and asking expo-audio for a different mode would reroute
 * the call. A chime that fails to play is logged and forgotten; the header
 * icon still shows the state.
 */
export function playChime(chime: Chime): void {
  try {
    const player = (players[chime] ??= createAudioPlayer(SOURCES[chime]));
    player.seekTo(0);
    player.play();
  } catch (e) {
    log.warn(`Could not play the ${chime} chime`, e);
  }
}
