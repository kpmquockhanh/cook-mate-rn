# "Hey CookMate" wake-word model

Trains the classifier the app's `modules/wake-word` runs on device. The two
feature models (melspectrogram, embedding) are openWakeWord's frozen ones and
are only copied, never retrained.

## Data you have to supply

- `data/background/kitchen/`: 16 kHz mono WAVs of kitchen sound with no one
  saying the phrase: extractor fan, sizzling, running tap, dishes, TV, radio,
  family chatter in English and Vietnamese. Aim for 5+ hours. Record your own,
  and add CC0 clips from freesound.org. `setup.sh` already fills the sibling
  `data/background/audioset/` with 4 h of general speech, music and noise, but
  nothing in AudioSet sounds like your own fan at 1 m from the phone, so the
  augmenter weights this folder 2x (`background_paths_duplication_rate`).
- `data/eval/positive_1m/` and `data/eval/positive_3m/`: **real** recordings of
  "Hey CookMate" at 1 m and 3 m from a phone on a counter, from at least 10
  speakers, both English- and Vietnamese-accented, 5 takes each, with kitchen
  noise in some. One phrase per file.
- `data/eval/negative/`: at least 3 hours of real kitchen and conversation
  audio that never contains the phrase. Keep it separate from
  `data/background/kitchen/`.

## Recording it

Record on a phone, not on this machine: WSL has no microphone, and the model is
deployed on a phone mic, so the eval numbers only mean something if the eval
audio came through one. Any recorder app is fine — whatever it produces has to
end up as the 16 kHz mono WAVs the folders need.

- **Kitchen background (5+ h).** Start a recording, put the phone on the counter, and
  cook. One long take per session is easiest; chunk it into a few minutes each
  when you convert. Cover the extractor fan on each speed, sizzling, the tap,
  dishes, the TV or radio, and family chatter in English and Vietnamese. Top it
  up with CC0 clips from freesound.org.
- **Eval positives.** Phone on the counter, speaker at 1 m, one continuous take
  of "Hey CookMate" five times with a pause between each; repeat at 3 m. Ten
  speakers, English- and Vietnamese-accented, some takes with the fan or a pan
  going. Cut each take on the pauses so every file holds one phrase, which is
  what `evaluate.py` expects.
- **Eval negatives (3+ h).** Same as background but recorded on different days
  or in different rooms, and nobody says the phrase. It must not overlap
  `data/background/kitchen/` — the model trains on that audio, so reusing it would
  score the false-wake rate on data the model has already seen.

Copy the files off the phone to anywhere WSL can read (`/mnt/c/Users/...` for
the Windows side), then convert each one with ffmpeg:

    ffmpeg -i in.m4a -ar 16000 -ac 1 data/eval/positive_1m/s01_01.wav

A long background or negative take is easier to handle in pieces — this cuts it
into 5-minute chunks:

    ffmpeg -i kitchen.m4a -ar 16000 -ac 1 -f segment -segment_time 300 data/background/kitchen/kitchen_%03d.wav

For eval positives, split each take on the pauses so one file holds one phrase,
and check a few by ear: a phrase clipped at the onset of "hey" or two phrases in
one file will both skew the scores. Never convert from a folder under `data/`
into another one, or you will re-import audio that is already in the set.

## Steps

    ./setup.sh
    source .venv/bin/activate
    python3 work/openWakeWord/openwakeword/train.py --training_config hey_cookmate.yml --generate_clips
    python3 gen_vi_clips.py --out work/out/hey_cookmate/positive_train --count 5000
    python3 gen_vi_clips.py --out work/out/hey_cookmate/positive_test --count 500
    python3 work/openWakeWord/openwakeword/train.py --training_config hey_cookmate.yml --augment_clips
    python3 work/openWakeWord/openwakeword/train.py --training_config hey_cookmate.yml --train_model
    python3 evaluate.py --threshold 0.5

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
  `custom_negative_phrases`, add that audio to `data/background/kitchen/`, raise
  `max_negative_weight`, and retrain. Raising the app threshold
  (`WAKE_THRESHOLD` in `lib/wakeWord/WakeWordDetector.ts`) is the last resort.
  If you change it, record the new value here and rerun `evaluate.py` with it.

## Current model

- Not trained yet. Fill in the date, openWakeWord tag, threshold and the evaluate.py numbers in the same commit as the model.
- Until then, `modules/wake-word/models/hey_cookmate.onnx` is a **placeholder**: openWakeWord's
  pretrained `hey_jarvis_v0.1.onnx` (release tag `v0.5.1`), renamed so the app code needs no
  changes once a real "hey_cookmate" model lands. Saying "Hey Jarvis" triggers detection during
  this flow-testing phase, not "Hey CookMate". `melspectrogram.onnx` and `embedding_model.onnx`
  in the same directory are the frozen, phrase-independent feature models from the same release
  and do not need to be retrained - only the classifier does.
