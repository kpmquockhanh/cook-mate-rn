#!/usr/bin/env bash
# Downloads everything openWakeWord's trainer expects. ~20 GB; run once.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data work data/background data/eval/positive_1m data/eval/positive_3m data/eval/negative

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# openWakeWord trainer and the synthetic-speech generator it drives.
[ -d work/openWakeWord ] || git clone --depth 1 --branch v0.6.0 https://github.com/dscripka/openWakeWord work/openWakeWord
[ -d work/piper-sample-generator ] || git clone --depth 1 https://github.com/rhasspy/piper-sample-generator work/piper-sample-generator
curl -L -o work/piper-sample-generator/models/en_US-libritts_r-medium.pt \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt

# Frozen feature models shared by every openWakeWord model.
curl -L -o data/melspectrogram.onnx https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx
curl -L -o data/embedding_model.onnx https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx

# Precomputed negative features (~2 000 h of speech/noise/music) and the
# false-positive validation set.
curl -L -o data/openwakeword_features_ACAV100M_2000_hrs_16bit.npy \
  https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy
curl -L -o data/validation_set_features.npy \
  https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy

# Room impulse responses for reverb augmentation.
python - <<'PY'
import datasets, soundfile as sf, os
os.makedirs("data/rirs", exist_ok=True)
ds = datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True)
for i, row in enumerate(ds):
    sf.write(f"data/rirs/{i}.wav", row["audio"]["array"], row["audio"]["sampling_rate"])
PY

# Vietnamese TTS voice for accented positives (see gen_vi_clips.py).
mkdir -p data/piper-vi
curl -L -o data/piper-vi/vi_VN-vais1000-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx
curl -L -o data/piper-vi/vi_VN-vais1000-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx.json

echo "Now fill data/background/ with kitchen noise (see README) and data/eval/ with real recordings."
