// Writes the two wake-word sounds. Generated rather than downloaded so there is
// no licence to track, and so the pitch or length can be changed in one place.
// Run: node scripts/generate-chimes.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const RATE = 44100;

/** A short two-note figure with a fast attack and a soft decay. */
function notes(freqs, noteMs, gain = 0.3) {
  const perNote = Math.round((RATE * noteMs) / 1000);
  const samples = new Int16Array(perNote * freqs.length);
  freqs.forEach((freq, n) => {
    for (let i = 0; i < perNote; i++) {
      const attack = Math.min(1, i / (RATE * 0.005));
      const decay = Math.exp((-4 * i) / perNote);
      const value = Math.sin((2 * Math.PI * freq * i) / RATE) * attack * decay * gain;
      samples[n * perNote + i] = Math.round(value * 32767);
    }
  });
  return samples;
}

function wav(samples) {
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

mkdirSync('assets/sounds', { recursive: true });
// Rising: "I'm listening". Falling: "I've stopped".
writeFileSync('assets/sounds/wake-open.wav', wav(notes([880, 1320], 90)));
writeFileSync('assets/sounds/wake-close.wav', wav(notes([660, 440], 90)));
console.log('wrote assets/sounds/wake-open.wav and wake-close.wav');
