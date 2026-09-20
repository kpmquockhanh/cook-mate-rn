## CookMate – The Smart Cooking Companion

Voice‑first, hands‑free cooking companion that orchestrates multi‑timers and step guidance to reduce stress and improve outcomes.

### Key Features (MVP)
- **Voice‑first AI assistant**: LiveKit voice agent with intents for next/prev/repeat step, timer control, and cooking questions — talk naturally, no wake‑word needed.
- **Intelligent multi‑timers**: Auto‑created from recipe metadata; orchestrates overlaps and announces near-completion.
- **Guided Cooking Mode**: Adaptive step progression with ingredient callouts and concise instructions.
- **Recipe catalog**: Curated set optimized for Cooking Mode; basic search/filter.
- **Auth & Sync**: Email/provider login (Supabase) with progress/preferences persistence.
- **Shopping list (basic)**: Add ingredients from recipes; quick quantity view/edit.

### Tech Stack
- **Mobile/Web**: React Native + Expo (TypeScript)
- **Navigation**: Expo Router
- **Backend**: Supabase (Auth, DB, Realtime)
- **State**: React Context + custom hooks; offline‑first cache
- **Notifications**: Local notifications for timers; background resilience

---

## Installation

### Prerequisites
- Node.js 22 (pinned in `.nvmrc`; `nvm use` picks it up). This is the major the
  backend/agent Docker images build on - keep `.nvmrc` and the Dockerfiles in step.
- npm (the repo has three `package-lock.json` files; CI uses `npm ci`)
- Expo CLI: `npm i -g expo`
- macOS: Xcode + Command Line Tools, CocoaPods (`sudo gem install cocoapods`)
- Android: Android Studio with SDKs and an emulator; set `ANDROID_HOME`
- Optional (macOS): Watchman `brew install watchman`

### 1) Clone and set up
```bash
git clone https://github.com/your-org/cook-mate-rn.git
cd cook-mate-rn
nvm use        # Node 22, per .nvmrc
npm run setup
```

`npm run setup` installs dependencies for all three packages (the app, `backend/`
and `agent/`), creates any missing `.env` from its `.env.example`, and prints
which values are still placeholders. It is safe to re-run - an existing `.env`
is never overwritten.

### 2) Environment
The repo has three independent env sets, each with a tracked template:

| File | Used by | Notes |
| --- | --- | --- |
| `.env` | the Expo app | `EXPO_PUBLIC_*` only, and every value is **public** - it is inlined into the JS bundle at build time |
| `backend/.env` | API, crawler pipeline, console | server secrets: `DATABASE_URL`, provider keys, service-role key |
| `agent/.env` | LiveKit voice agent | `LIVEKIT_*` server secrets |

`npm run setup` copies all three. To check them at any time:

```bash
npm run env:check
```

That reports drift in both directions: variables read somewhere in code but
documented in no `.env.example` (the failure mode that silently breaks a
teammate's clone), and variables in your `.env` that the template never
mentions. It runs in CI too, where it checks the code-vs-template half only.

The app validates its own environment at startup in `lib/env.ts`, so a missing
`EXPO_PUBLIC_*` value fails immediately, naming every variable that is missing,
rather than surfacing later as an opaque error. Expo inlines these at build
time - after editing `.env`, restart the dev server.

### 3) Run the app
```bash
npx expo start
```
- Press `i` to run on iOS Simulator (macOS/Xcode)
- Press `a` to run on Android Emulator
- Press `w` to open Web

If iOS native install is required (rare for managed Expo), run inside `ios` directory:
```bash
cd ios && pod install && cd -
```

### Common scripts
```bash
# Dev server
npm run start

# Platform shortcuts
npm run ios
npm run android
npm run web

# Checks (CI runs all of these)
npm run typecheck    # tsc --noEmit
npm run env:check    # .env / .env.example / code drift, all three packages
npm run lint         # eslint + prettier

# Backend has its own
cd backend && npm run typecheck && npm test
```

Note: `npm run lint` currently reports pre-existing errors (mostly
`react-hooks` rules, plus the Deno `npm:` imports in `supabase/functions/` that
the Node resolver cannot see). CI runs it non-blocking until that backlog is
cleared - see `.github/workflows/ci.yml`.

---

## Building and Release (EAS)
EAS is recommended for builds and OTA updates.
```bash
npm install -g eas-cli
eas login
eas init

# Build
eas build -p ios   # iOS
eas build -p android

# Submit (after successful build)
eas submit -p ios
eas submit -p android
```

---

## Backend & Agent (Docker)

The recipe pipeline/API (`backend/`) and the voice agent (`agent/`) run as
containers via the root `docker-compose.yml` — the Expo app itself stays a
local/EAS build, not a container:

```bash
cp backend/.env.example backend/.env   # DATABASE_URL, provider keys, SUPABASE_URL,
                                        # REVIEW_USERNAME/REVIEW_PASSWORD
cp agent/.env.example agent/.env       # LIVEKIT_*
docker compose up --build
```

This starts three services: the app API (`8787`), the pipeline's operator
console (`5174`, HTTP Basic Auth via `REVIEW_USERNAME`/`REVIEW_PASSWORD`), and
the voice agent worker. See `backend/README.md#docker` for details.

## Project Structure (high level)
```
app/                 # Expo Router screens
components/          # Reusable UI and feature components
hooks/               # Custom hooks (state, data, voice)
assets/              # Images, fonts, sounds
docs/                # PRD and brief
```

---

## Roadmap (from PRD)
- M0: POC wake‑word + sample recipe Cooking Mode
- M1: Multi‑timer v1; 20 curated recipes; offline cache
- M2: Auth + sync; 60 recipes; onboarding + tutorial
- M3 (MVP): 100+ recipes; analytics; polishing; TestFlight/Closed beta

---

## License
MIT (or update as appropriate)
