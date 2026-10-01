## CookMate – The Smart Cooking Companion

Voice‑first, hands‑free cooking companion that orchestrates multi‑timers and step guidance to reduce stress and improve outcomes.

### Key Features (MVP)
- **Voice‑first AI assistant**: LiveKit voice agent with intents for next/prev/repeat step, timer control, and cooking questions — talk naturally, no wake‑word needed.
- **Intelligent multi‑timers**: Auto‑created from recipe metadata; orchestrates overlaps and announces near-completion.
- **Guided Cooking Mode**: Adaptive step progression with ingredient callouts and concise instructions.
- **Recipe catalog**: Curated set optimized for Cooking Mode; basic search/filter.
- **Auth & Sync**: Email and Google login (Clerk) with progress/preferences persistence.
- **Shopping list (basic)**: Add ingredients from recipes; quick quantity view/edit.

### Tech Stack
- **Mobile/Web**: React Native + Expo (TypeScript)
- **Navigation**: Expo Router
- **Auth**: Clerk
- **Backend**: Fastify API + Postgres; MinIO (S3) for images
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
| `backend/.env` | API, crawler pipeline, console | server secrets: `DATABASE_URL`, provider keys, `S3_*`, `CLERK_*` |
| `agent/.env` | LiveKit voice agent | `LIVEKIT_*` server secrets |

`npm run setup` copies all three. To check them at any time:

```bash
npm run env:check
```

That reports drift in both directions: variables read somewhere in code but
documented in no `.env.example` (the failure mode that silently breaks a
teammate's clone), and variables in your `.env` that the template never
mentions. CI does not run it yet - run it yourself before pushing.

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

# Checks for the app (not in CI yet - run them locally)
npm run typecheck    # tsc --noEmit
npm run env:check    # .env / .env.example / code drift, all three packages
npm run lint         # eslint + prettier

# Backend and agent have their own (these are what CI runs)
cd backend && npm run typecheck && npm test
cd agent && npm run typecheck && npm test
```

Note: `npm run lint` currently reports pre-existing errors (mostly
`react-hooks` rules). CI (`.github/workflows/ci.yml`) only covers
`backend/` and `agent/` for now, so the app's typecheck, env check and lint
are not enforced on pull requests.

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

## Clerk setup

In the Clerk dashboard for the development instance:
1. **User & authentication → Email, phone, username**: email address on, "Verify at sign-up" with email code; password on.
2. **SSO connections**: add Google (dev instances can use Clerk's shared credentials).
3. **Native applications**: add iOS and Android `com.kpmquockhanh.cookmate`; add `cookmate://sso-callback` and the web redirect URL `http://localhost:8081/sso-callback` (plus your production web origin's `/sso-callback`) to the allowlisted redirect URLs.
4. **Sessions → Customize session token**: `{ "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }`.
5. Copy the publishable key into root `.env` and the Frontend API URL into `backend/.env` as `CLERK_ISSUER`; set `CLERK_AUTHORIZED_PARTIES=http://localhost:8081` for web.

Test users: in a development instance, any `+clerk_test` email signs in with code `424242`.

Production: create a production instance with its own Google OAuth credentials and put its Frontend API URL in `CLERK_ISSUER`. Sign in with Apple is a planned follow-up (App Store guideline 4.8).

## Backend & Agent (Docker)

The recipe pipeline/API (`backend/`) and the voice agent (`agent/`) run as
containers via the root `docker-compose.yml` — the Expo app itself stays a
local/EAS build, not a container:

```bash
cp backend/.env.example backend/.env   # POSTGRES_PASSWORD, MINIO_ROOT_USER/PASSWORD,
                                        # DATABASE_URL, provider keys, CLERK_ISSUER, LIVEKIT_*,
                                        # S3_* (MinIO credentials),
                                        # REVIEW_USERNAME/REVIEW_PASSWORD
cp agent/.env.example agent/.env       # LIVEKIT_*
docker compose up -d postgres minio && (cd backend && npm run setup)   # once
docker compose up --build
```

This starts Postgres (`127.0.0.1:5432`), MinIO (`9000`, console on
`127.0.0.1:9001`), the app API (`8787`), the pipeline's operator console
(`5174`, HTTP Basic Auth via `REVIEW_USERNAME`/`REVIEW_PASSWORD`), and the
voice agent worker. See `backend/README.md#docker` for details.

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
