"""Streams AudioSet down into the 16 kHz mono WAVs the augmenter mixes under
the training clips.

Without this, `background_paths` scans an empty folder and openWakeWord builds
its augmentation with no `AddBackgroundNoise` at all, so the model only ever
sees near-clean speech and false-fires the moment a real kitchen is running.

AudioSet is one source for all three kinds of background that matter here --
speech, music (the radio or TV) and noise -- so this streams it rather than
also pulling FMA the way openWakeWord's own notebook does; FMA ships as a zip,
which HTTP streaming cannot seek into.

This is a supplement, not a replacement for `data/background/kitchen/`: nothing
in AudioSet sounds like your extractor fan at 1 m from the phone.
"""
import argparse
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

RATE = 16000
CLIP_SECONDS = 10  # what AudioSet ships; one row is one file


def to_pcm16(array: np.ndarray, sampling_rate: int) -> np.ndarray:
    """AudioSet is 48 kHz float; resample_poly gets the clean /3 decimation."""
    if array.ndim > 1:
        array = array.mean(axis=1)
    if sampling_rate != RATE:
        g = np.gcd(int(sampling_rate), RATE)
        array = resample_poly(array, RATE // g, sampling_rate // g)
    return (np.clip(array, -1.0, 1.0) * 32767).astype(np.int16)


def write(path: Path, pcm: np.ndarray) -> None:
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(pcm.tobytes())


def hours_in(out: Path) -> float:
    return sum(f.stat().st_size for f in out.glob("*.wav")) / (RATE * 2) / 3600


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="data/background/audioset")
    parser.add_argument("--hours", type=float, default=4.0,
                        help="stop once the folder holds this many hours")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    have = hours_in(out)
    if have >= args.hours:
        print(f"{out} already holds {have:.2f} h, nothing to do")
        return

    import datasets  # slow to import, and only this path needs it

    target = int((args.hours - have) * 3600 / CLIP_SECONDS)
    print(f"{out} holds {have:.2f} h; streaming ~{target} more clips from AudioSet")

    # Streaming, because the full set is ~1 TB and we want a few hours of it.
    rows = datasets.load_dataset(
        "agkphysics/AudioSet", split="train", streaming=True, trust_remote_code=True
    )

    written = 0
    for row in rows:
        if written >= target:
            break
        audio = row["audio"]
        pcm = to_pcm16(np.asarray(audio["array"]), audio["sampling_rate"])
        if len(pcm) < RATE:  # a stub, not worth a file
            continue
        if np.abs(pcm).mean() < 50:  # near-silent clips teach the model nothing
            continue
        path = out / f"{row['video_id']}.wav"
        if path.exists():
            continue
        write(path, pcm)
        written += 1
        if written % 100 == 0:
            print(f"  {written}/{target} clips ({hours_in(out):.2f} h)")

    print(f"wrote {written} files to {out} ({hours_in(out):.2f} h in the folder)")


if __name__ == "__main__":
    main()
