"""Vietnamese-accented "Hey CookMate" positives.

openWakeWord's generator only speaks English, and most CookMate users say the
brand name with a Vietnamese accent. A Vietnamese Piper voice reading phonetic
spellings of the phrase gets close to how it is actually said. The clips are
dropped into the trainer's positive folders before augmentation, so they get
the same noise and reverb treatment as the English ones.
"""
import argparse
import random
import wave
from pathlib import Path

import numpy as np
from piper import PiperVoice
from scipy.signal import resample_poly

SPELLINGS = [
    "hây cúc mét",
    "hê cúc mét",
    "hây cúc mây",
    "hey cúc mét",
    "hây, cúc mét",
    "ê cúc mét",
]


def synth(voice: PiperVoice, text: str, length_scale: float, noise_scale: float) -> np.ndarray:
    chunks = []
    for audio in voice.synthesize_stream_raw(
        text, length_scale=length_scale, noise_scale=noise_scale, noise_w=0.8
    ):
        chunks.append(np.frombuffer(audio, dtype=np.int16))
    pcm = np.concatenate(chunks).astype(np.float32)
    rate = voice.config.sample_rate
    return resample_poly(pcm, 16000, rate).clip(-32768, 32767).astype(np.int16)


def write(path: Path, pcm: np.ndarray) -> None:
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(pcm.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", default="data/piper-vi/vi_VN-vais1000-medium.onnx")
    parser.add_argument("--out", required=True, help="e.g. work/out/hey_cookmate/positive_train")
    parser.add_argument("--count", type=int, default=5000)
    args = parser.parse_args()

    voice = PiperVoice.load(args.voice)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(7)
    for i in range(args.count):
        pcm = synth(
            voice,
            rng.choice(SPELLINGS),
            length_scale=rng.uniform(0.8, 1.3),
            noise_scale=rng.uniform(0.4, 0.9),
        )
        write(out / f"vi_{i:05d}.wav", pcm)
    print(f"wrote {args.count} clips to {out}")


if __name__ == "__main__":
    main()
