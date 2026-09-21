"""Scores a trained model against real recordings, and writes the golden
scores the native pipelines are checked against.

Pass bar (from the spec): >= 90 % detection at 1 m, >= 80 % at 3 m,
<= 1 false wake per hour of negative audio.
"""
import argparse
import json
import shutil
import wave
from pathlib import Path

import numpy as np
from openwakeword.model import Model

CHUNK = 1280
WARMUP_SAMPLES = 2 * 16000  # 2 s of silence, prepended before scoring


def load(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as f:
        assert f.getframerate() == 16000 and f.getnchannels() == 1 and f.getsampwidth() == 2, (
            f"{path}: must be 16 kHz mono 16-bit (ffmpeg -i in -ar 16000 -ac 1 out.wav)"
        )
        return np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16)


def pad(pcm: np.ndarray) -> np.ndarray:
    """Prepend 2 s of int16 silence so the streaming pipelines are fully warmed
    up before the phrase starts. openWakeWord returns 0.0 for its first ~5
    predictions after `model.reset()` (~400 ms), and the native pipelines
    (Tasks 7/8) return no score at all until 16 real embeddings exist (~1.3 s).
    A tightly trimmed "one phrase per file" clip would otherwise score that
    warm-up window instead of the phrase, and native/Python would disagree."""
    return np.concatenate([np.zeros(WARMUP_SAMPLES, dtype=np.int16), pcm])


def write_wav(path: Path, pcm: np.ndarray) -> None:
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(16000)
        f.writeframes(pcm.tobytes())


def scores(model: Model, pcm: np.ndarray) -> list[float]:
    model.reset()
    out = []
    for start in range(0, len(pcm) - CHUNK + 1, CHUNK):
        out.append(float(model.predict(pcm[start : start + CHUNK])["hey_cookmate"]))
    return out


def detection_rate(model: Model, folder: Path, threshold: float) -> float:
    clips = sorted(folder.glob("*.wav"))
    assert clips, f"no clips in {folder}"
    hits = sum(max(scores(model, pad(load(c)))) >= threshold for c in clips)
    return hits / len(clips)


def false_wakes_per_hour(model: Model, folder: Path, threshold: float, cooldown_chunks: int = 19) -> float:
    total_chunks, wakes = 0, 0
    for clip in sorted(folder.glob("*.wav")):
        s = scores(model, pad(load(clip)))
        total_chunks += len(s)
        i = 0
        while i < len(s):
            if s[i] >= threshold:
                wakes += 1
                i += cooldown_chunks  # 1.5 s, matching WAKE_COOLDOWN_MS
            else:
                i += 1
    hours = total_chunks * CHUNK / 16000 / 3600
    assert hours > 0, f"no negative audio in {folder}"
    return wakes / hours


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="work/out/hey_cookmate.onnx")
    parser.add_argument("--eval", default="data/eval")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--export", default="../../modules/wake-word")
    args = parser.parse_args()

    model = Model(
        wakeword_models=[args.model],
        inference_framework="onnx",
        melspec_model_path="data/melspectrogram.onnx",
        embedding_model_path="data/embedding_model.onnx",
    )
    ev = Path(args.eval)
    near = detection_rate(model, ev / "positive_1m", args.threshold)
    far = detection_rate(model, ev / "positive_3m", args.threshold)
    fph = false_wakes_per_hour(model, ev / "negative", args.threshold)
    print(f"detection @1m: {near:.1%}  (need >= 90%)")
    print(f"detection @3m: {far:.1%}  (need >= 80%)")
    print(f"false wakes/hour: {fph:.2f}  (need <= 1)")
    passed = near >= 0.9 and far >= 0.8 and fph <= 1
    print("PASS" if passed else "FAIL")

    export = Path(args.export)
    (export / "models").mkdir(parents=True, exist_ok=True)
    (export / "test-audio").mkdir(parents=True, exist_ok=True)
    shutil.copy(args.model, export / "models" / "hey_cookmate.onnx")
    shutil.copy("data/melspectrogram.onnx", export / "models" / "melspectrogram.onnx")
    shutil.copy("data/embedding_model.onnx", export / "models" / "embedding_model.onnx")

    positive = sorted((ev / "positive_1m").glob("*.wav"))[0]
    negative = sorted((ev / "negative").glob("*.wav"))[0]
    positive_pcm = pad(load(positive))
    neg_pcm = pad(load(negative)[: 16000 * 20])  # 20 s is plenty for parity
    # Both exported clips are the padded audio golden.json was scored on, so
    # the native parity check (Tasks 7/8) sees the same warm-up Python did.
    write_wav(export / "test-audio" / "positive.wav", positive_pcm)
    write_wav(export / "test-audio" / "negative.wav", neg_pcm)
    golden = {
        "positive": max(scores(model, positive_pcm)),
        "negative": max(scores(model, neg_pcm)),
    }
    (export / "test-audio" / "golden.json").write_text(json.dumps(golden, indent=2) + "\n")
    print(f"golden scores: {golden}")
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
