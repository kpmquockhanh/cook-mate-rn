#!/usr/bin/env bash
# Downloads everything openWakeWord's trainer expects. ~20 GB; run once.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data work data/background/kitchen data/background/audioset \
         data/eval/positive_1m data/eval/positive_3m data/eval/negative

# openWakeWord's tflite-runtime, piper-tts and numpy<2 have no wheels past
# CPython 3.11, so pin the venv to 3.11 rather than whatever python3 happens to be.
if command -v uv >/dev/null; then
  uv python install 3.11
  uv venv --python 3.11 .venv
  source .venv/bin/activate
  uv pip install -r requirements.txt
elif command -v python3.11 >/dev/null; then
  python3.11 -m venv .venv
  source .venv/bin/activate
  pip3 install -r requirements.txt
else
  echo "Need CPython 3.11: install uv (https://docs.astral.sh/uv/) or python3.11." >&2
  exit 1
fi

# DeepPhonemizer (pulled in for generate_adversarial_texts) predates the same
# PyTorch 2.6 weights_only change as the piper checkpoint below, and its
# checkpoint is a pickled Preprocessor. It is fetched over HTTPS from the
# library's own S3 bucket at first use.
DP_MODEL="$(python3 -c 'import dp.model.model as m; print(m.__file__)')"
grep -q "weights_only=False" "$DP_MODEL" ||
  sed -i 's/torch\.load(checkpoint_path, map_location=device)/torch.load(checkpoint_path, map_location=device, weights_only=False)/' "$DP_MODEL"

# torchaudio 2.9 dropped its own decoders and routes load()/info() through
# TorchCodec, which openWakeWord v0.6.0 predates: data.py calls both in nine
# places and every one of them raises ImportError. TorchCodec also needs
# FFmpeg's *shared* libraries, which the static ffmpeg build on this box does
# not provide, so point the two calls at soundfile instead -- every file they
# open here is a 16 kHz WAV, which soundfile reads natively.
OWW_DATA="$(python3 -c 'import openwakeword.data as d; print(d.__file__)')"
grep -q "patched by setup.sh" "$OWW_DATA" || python3 - "$OWW_DATA" <<'PY'
import sys
from pathlib import Path

p = Path(sys.argv[1])
src = p.read_text()
shim = '''
# --- patched by setup.sh: soundfile in place of the TorchCodec backend ---
import soundfile as _sf
import torch as _torch


def _sf_load(uri, *args, **kwargs):
    data, sr = _sf.read(str(uri), dtype="float32", always_2d=True)
    return _torch.from_numpy(data.T).contiguous(), sr


class _SfInfo:
    def __init__(self, info):
        self.sample_rate = info.samplerate
        self.num_frames = info.frames
        self.num_channels = info.channels


def _sf_info(uri, *args, **kwargs):
    # data.py catches RuntimeError around info(); LibsndfileError subclasses it.
    return _SfInfo(_sf.info(str(uri)))


torchaudio.load = _sf_load
torchaudio.info = _sf_info
# --- end patch ---
'''
assert "import torchaudio\n" in src, "import torchaudio not found in data.py"
p.write_text(src.replace("import torchaudio\n", "import torchaudio\n" + shim, 1))
PY

# Skip anything already on disk so a rerun after a failure is cheap; the
# feature .npy below alone is 17 GB.
fetch() { [ -s "$1" ] || curl -L --fail -o "$1" "$2"; }

# openWakeWord trainer and the synthetic-speech generator it drives.
[ -d work/openWakeWord ] || git clone --depth 1 --branch v0.6.0 https://github.com/dscripka/openWakeWord work/openWakeWord
# v2.0.0, not the default branch: openWakeWord v0.6.0 does
# `from generate_samples import generate_samples`, and v3.x moved that module
# into a piper_sample_generator/ package. The .pt below is the v2.0.0 release asset.
[ -d work/piper-sample-generator ] || git clone --depth 1 --branch v2.0.0 https://github.com/rhasspy/piper-sample-generator work/piper-sample-generator
fetch work/piper-sample-generator/models/en_US-libritts_r-medium.pt \
  https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt

# The v2.0.0 generator predates PyTorch 2.6, which flipped torch.load's
# weights_only default to True; the checkpoint is a pickled SynthesizerTrn, so
# it no longer loads. Downgrading torch is not an option (Blackwell GPUs need
# >= 2.7), so opt this one call back out. The file is the official release
# asset fetched over HTTPS just above.
grep -q "weights_only=False" work/piper-sample-generator/generate_samples.py ||
  sed -i 's/model = torch\.load(model_path)/model = torch.load(model_path, weights_only=False)/' \
    work/piper-sample-generator/generate_samples.py

# The trainer expands the false-positive validation set (481k x 96 frames) into
# every 16-frame window up front -- ~3 GB -- and then feeds the whole thing to
# the model as a single batch, which torch copies again. That peaks around 6 GB
# at the first validation step (75% of the way through sequence 1) and wedges
# any box with 8 GB of RAM. Cut the same windows one batch at a time instead;
# the false-positive metric is a plain sum, so the totals are unchanged.
OWW_TRAIN="work/openWakeWord/openwakeword/train.py"
grep -q "patched by setup.sh" "$OWW_TRAIN" || python3 - "$OWW_TRAIN" <<'PY2'
import sys
from pathlib import Path

p = Path(sys.argv[1])
src = p.read_text()
old = """        X_val_fp = np.load(config["false_positive_validation_data_path"])
        X_val_fp = np.array([X_val_fp[i:i+input_shape[0]] for i in range(0, X_val_fp.shape[0]-input_shape[0], 1)])  # reshape to match model
        X_val_fp_labels = np.zeros(X_val_fp.shape[0]).astype(np.float32)
        X_val_fp = torch.utils.data.DataLoader(
            torch.utils.data.TensorDataset(torch.from_numpy(X_val_fp), torch.from_numpy(X_val_fp_labels)),
            batch_size=len(X_val_fp_labels)
        )
"""
new = """        # --- patched by setup.sh: stream the false-positive validation windows ---
        class _FalsePositiveWindows(torch.utils.data.IterableDataset):
            def __init__(self, features, window, batch_size=4096):
                self.features = features
                self.window = window
                self.batch_size = batch_size

            def __iter__(self):
                n = self.features.shape[0] - self.window
                for start in range(0, n, self.batch_size):
                    stop = min(start + self.batch_size, n)
                    x = np.stack([self.features[i:i + self.window] for i in range(start, stop)])
                    yield torch.from_numpy(x), torch.zeros(stop - start, dtype=torch.float32)

        X_val_fp = torch.utils.data.DataLoader(
            _FalsePositiveWindows(
                np.load(config["false_positive_validation_data_path"]), input_shape[0]),
            batch_size=None
        )
        # --- end patch ---
"""
assert old in src, "false-positive validation loader not found in train.py"
src = src.replace(old, new, 1)

# The tflite conversion needs tensorflow and the abandoned onnx-tf, and it runs
# after the onnx file is already written -- nothing here or in modules/wake-word
# reads tflite, so drop the call rather than carrying those two dependencies.
old = """        # Convert the model from onnx to tflite format
        convert_onnx_to_tflite(os.path.join(config["output_dir"], config["model_name"] + ".onnx"),
                               os.path.join(config["output_dir"], config["model_name"] + ".tflite"))
"""
new = """        # --- patched by setup.sh: onnx only, this project never loads tflite ---
"""
assert old in src, "tflite conversion call not found in train.py"
p.write_text(src.replace(old, new, 1))
PY2

# Frozen feature models shared by every openWakeWord model.
fetch data/melspectrogram.onnx https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx
fetch data/embedding_model.onnx https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx

# The openwakeword wheel ships no models/ dir; AudioFeatures() loads these two
# from inside the package, so put the copies we just fetched where it looks.
OWW_MODELS="$(python3 -c 'import openwakeword, os; print(os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models"))')"
mkdir -p "$OWW_MODELS"
cp -n data/melspectrogram.onnx data/embedding_model.onnx "$OWW_MODELS"/

# Precomputed negative features (~2 000 h of speech/noise/music) and the
# false-positive validation set.
fetch data/openwakeword_features_ACAV100M_2000_hrs_16bit.npy \
  https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy
fetch data/validation_set_features.npy \
  https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy

# Room impulse responses for reverb augmentation. Decoding the dataset's audio
# column needs librosa, which is why it is in requirements.txt.
[ -n "$(ls -A data/rirs 2>/dev/null)" ] || python3 - <<'PY'
import datasets, soundfile as sf, os
os.makedirs("data/rirs", exist_ok=True)
ds = datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True)
for i, row in enumerate(ds):
    sf.write(f"data/rirs/{i}.wav", row["audio"]["array"], row["audio"]["sampling_rate"])
PY

# Background noise for the augmenter to mix under the clips. Without it
# openWakeWord builds its augmentation with no AddBackgroundNoise at all and
# the model only ever sees near-clean speech. Tops up to BACKGROUND_HOURS, so
# a rerun after a failure only fetches the shortfall.
python3 fetch_background.py --out data/background/audioset --hours "${BACKGROUND_HOURS:-4}"

# Vietnamese TTS voice for accented positives (see gen_vi_clips.py).
mkdir -p data/piper-vi
fetch data/piper-vi/vi_VN-vais1000-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx
fetch data/piper-vi/vi_VN-vais1000-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx.json

echo "AudioSet background is in data/background/audioset/. Now add your own kitchen"
echo "noise to data/background/kitchen/ and real recordings to data/eval/ (see README)."
