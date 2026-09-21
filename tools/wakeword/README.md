# "Hey CookMate" wake-word model

Trains the classifier the app's `modules/wake-word` runs on device. The two
feature models (melspectrogram, embedding) are openWakeWord's frozen ones and
are only copied, never retrained.

## Data you have to supply

- `data/background/`: 16 kHz mono WAVs of kitchen sound with no one saying the
  phrase: extractor fan, sizzling, running tap, dishes, TV, radio, family
  chatter in English and Vietnamese. Aim for 5+ hours. Record your own, and add
  CC0 clips from freesound.org.
- `data/eval/positive_1m/` and `data/eval/positive_3m/`: **real** recordings of
  "Hey CookMate" at 1 m and 3 m from a phone on a counter, from at least 10
  speakers, both English- and Vietnamese-accented, 5 takes each, with kitchen
  noise in some. One phrase per file.
- `data/eval/negative/`: at least 3 hours of real kitchen and conversation
  audio that never contains the phrase. Keep it separate from `data/background/`.

Convert anything to the right format with `ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav`.

## Steps

    ./setup.sh
    source .venv/bin/activate
    python work/openWakeWord/openwakeword/train.py --training_config hey_cookmate.yml --generate_clips
    python gen_vi_clips.py --out work/out/hey_cookmate/positive_train --count 5000
    python gen_vi_clips.py --out work/out/hey_cookmate/positive_test --count 500
    python work/openWakeWord/openwakeword/train.py --training_config hey_cookmate.yml --augment_clips
    python work/openWakeWord/openwakeword/train.py --training_config hey_cookmate.yml --train_model
    python evaluate.py --threshold 0.5

`evaluate.py` prints the three numbers and PASS or FAIL. Every clip is scored
with 2 s of silence prepended, so the streaming pipeline is fully warmed up
before the phrase starts (openWakeWord needs ~400 ms after a reset, the native
pipelines in `modules/wake-word` need ~1.3 s); without this a tightly trimmed
"one phrase per file" clip would score the warm-up window instead of the
phrase. `evaluate.py` also copies the models, a positive and a negative test
clip (both padded the same way, so native and Python parity checks score the
same audio `golden.json` was scored on), and `golden.json` into
`modules/wake-word/`, whatever the result. Commit only after a PASS.

## If it fails

- Low detection for Vietnamese-accented speakers: add more `SPELLINGS` in
  `gen_vi_clips.py`, or put a few hundred real recordings into
  `positive_train` and retrain.
- Too many false wakes: add the phrases it fired on to
  `custom_negative_phrases`, add that audio to `data/background/`, raise
  `max_negative_weight`, and retrain. Raising the app threshold
  (`WAKE_THRESHOLD` in `lib/wakeWord/WakeWordDetector.ts`) is the last resort.
  If you change it, record the new value here and rerun `evaluate.py` with it.

## Current model

- Not trained yet. Fill in the date, openWakeWord tag, threshold and the evaluate.py numbers in the same commit as the model.
