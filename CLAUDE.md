# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Three independent npm packages (each with its own `package-lock.json`, `.env`, `.env.example`, and tsconfig) plus supporting pieces:

- **Root** — the Expo / React Native app (Expo Router, NativeWind, Clerk auth, LiveKit voice). Screens in `app/`, shared state in `lib/*Context.tsx`, hooks in `hooks/`.
- **`backend/`** — a recipe pipeline (crawl → parse → enrich → gate → publish into Postgres) and the Fastify REST API the app reads (`backend/src/api`). Runs via `tsx`; there is no compiled build.
- **`agent/`** — the LiveKit voice-agent worker (`agent/src/agent.ts`), dispatched into rooms by name.
- **`modules/wake-word/`** — a local Expo native module (Swift/Kotlin) running openWakeWord ONNX models for "Hey CookMate". Training tooling lives in `tools/wakeword/` (Python).

`backend/README.md`, `agent/README.md` and `tools/wakeword/README.md` are detailed and authoritative for their packages — read them before changing those areas.

## Commands

Node 22 (`.nvmrc`; keep it in step with the Dockerfiles). `npm run setup` at the root installs all three packages and creates missing `.env` files.

App (root):
```bash
npm run start            # expo dev server (i / a / w for iOS / Android / web)
npm run ios | android    # native build (expo run:*) — needed after native module/plugin changes
npm run typecheck
npm test                 # tsx --test 'lib/**/*.test.ts'
npx tsx --test lib/listeningWindow.test.ts   # single test file
npm run lint             # eslint + prettier check; has a known pre-existing backlog of errors
npm run format
npm run env:check        # drift between code, .env and .env.example across all three packages
```

Backend (`cd backend`):
```bash
npm test                 # tsx --test test/*.test.ts — no DB or network needed (DB tests skip themselves)
npx tsx --test test/parse.test.ts
npm run typecheck
npm run api | api:dev    # API on :8787
npm run ui               # operator console on :5174 (requires REVIEW_USERNAME/REVIEW_PASSWORD)
npm run setup            # migrate + seed
npm run pipeline -- --limit 50 ; npm run publish -- --limit 50
npm run dev -- <subcommand>   # any src/cli.ts command (sources, runs, images, storage, unmatched, …)
```

Agent (`cd agent`):
```bash
npm install --ignore-scripts   # required: plain install fails in sharp's install script
npm run dev                    # watch mode; healthy start logs "registered worker" agentName "cookmate"
npm test ; npm run typecheck
```

`docker compose up --build` runs the backend API, the console, and the agent; the app itself is never containerized. CI (`.github/workflows/ci.yml`) currently only runs typecheck + tests for `backend/` and `agent/`.

Tests everywhere use Node's built-in runner (`node:test`) via `tsx --test`, not Jest.

## Architecture

### App ↔ backend
- All REST calls go through `apiFetch` in `lib/api.ts`: attaches the Clerk session token (via `lib/authToken.ts`, which `AuthContext` feeds), retries once on 401 with a freshly minted token, retries idempotent GETs on connection/gateway errors, and unwraps the `{ data }` envelope. It reports reachability to `lib/connectivity.ts`, which drives the offline/outage banner. Don't `fetch` the API directly.
- Every backend route except `/health` is authenticated by default (root `onRequest` hook in `backend/src/api/auth.ts`; making a route public means editing `PUBLIC_ROUTES`).
- The column names the publisher writes and the API selects live in `backend/src/publish/mapping.ts`; `test/api-contract.test.ts` diffs them so a rename fails tests instead of blanking a screen.
- `lib/env.ts` validates `EXPO_PUBLIC_*` at startup. Each variable must be written out as a literal `process.env.EXPO_PUBLIC_X` (Expo inlines them textually — no computed access). These values are public; restart the dev server after editing `.env`.

### Provider tree
`app/_layout.tsx` nests `ClerkProvider → AuthProvider → SettingsProvider → ShoppingProvider → FavoritesProvider → TimerProvider`. Order matters (settings feed timers/shopping; favorites need a session).

### i18n
English and Vietnamese (`lib/i18n/en.ts`, `vi.ts`), with `en.ts` defining `TranslationKey`. Components use the hook from `lib/i18n/index.ts`; non-React code uses `t()`. The active language comes from `SettingsContext`. User-facing strings should go through i18n.

### Voice pipeline
1. The cooking screen (`app/cooking/[id].tsx`) gets a token from the API's `POST /voice/token` (`lib/livekitToken.ts`, route in `backend/src/api/routes/voice.ts`). Room = `cooking-<uid>-<recipeId>`; the token carries an explicit agent dispatch for `cookmate`. That name must match `agent/src/constants.ts` **and** `AGENT_NAME` in `backend/src/api/routes/voice.ts` or no agent ever joins.
2. `components/LiveKitVoice.tsx` (native) / `LiveKitVoice.web.tsx` connects and publishes the current recipe/step as the participant attribute `cookmate_state`. **This contract is duplicated** in `lib/cookingContext.ts` and `agent/src/cooking-context.ts` (packages build separately) — change both together.
3. The agent drives the screen via RPC methods the app registers (`navigate_next`, `navigate_back`, `repeat_step`, `close_listening`); the app calls the agent's `interrupt` RPC.
4. On native, the mic stays muted until a *listening window* opens (wake word or mic tap). The window is a pure state machine in `lib/listeningWindow.ts` (unit-tested) wrapped by `hooks/useListeningWindow.ts`. Session states shared by both LiveKitVoice variants and the screen are defined in `lib/voiceSession.ts`.
5. Wake word: `lib/wakeWord/WakeWordDetector.ts` is an engine-agnostic, native-free interface (testable under Node); `index.ts` wires the Expo module, `index.web.ts` supplies an inert detector. The ONNX models in `modules/wake-word/models/` are bundled via the podspec's `resource_bundles` (iOS) — they must end up in the app bundle.

Platform splits use `.web.tsx` / `.web.ts` suffixes resolved by Metro.

### Backend pipeline
`crawl_queue → raw_pages (immutable, HTML in object storage) → recipe_staging → public.recipes`. Conventions, invariants and API details are in `backend/CLAUDE.md`.
