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
- Node.js 18+ (LTS recommended)
- Package manager: npm, yarn, or pnpm
- Expo CLI: `npm i -g expo`
- macOS: Xcode + Command Line Tools, CocoaPods (`sudo gem install cocoapods`)
- Android: Android Studio with SDKs and an emulator; set `ANDROID_HOME`
- Optional (macOS): Watchman `brew install watchman`

### 1) Clone and install
```bash
git clone https://github.com/your-org/cook-mate-rn.git
cd cook-mate-rn
npm install # or yarn / pnpm i
```

### 2) Environment
Create your env file(s):
```bash
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_ANON_KEY, etc.
```

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

# Lint & type-check
npm run lint
npm run typecheck
```

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
