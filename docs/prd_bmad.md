# CookMate Product Requirements Document (PRD)

## Goals and Background Context

### Goals
- Deliver a hands‑free Cooking Mode with reliable wake‑word voice control.
- Orchestrate multiple cooking timers intelligently to reduce user stress.
- Provide clear, adaptive step‑by‑step guidance that fits user pace.
- Ship an MVP on iOS and Android within 6 months by a solo developer.
- Achieve strong engagement and retention with a curated recipe set.

### Background Context
CookMate targets the core pain points of traditional recipe apps during actual cooking: constant phone interaction with messy hands, poor coordination of parallel tasks, and no adaptation to user pace. By centering on a voice‑first Cooking Mode, intelligent multi‑timer orchestration, and contextual, concise step guidance, the app provides real‑time assistance that reduces stress and improves outcomes. Market trends show growth in cooking apps and high kitchen voice‑assistant usage, but retention lags due to weak execution support—CookMate fills this gap with a differentiated execution experience.

### Change Log
| Date       | Version | Description                         | Author |
|------------|---------|-------------------------------------|--------|
| 2025-09-08 | 0.1     | Initial PRD aligned to PM template  | PM     |

## Requirements

### Functional (FR)
1. FR1: Support wake‑word activation ("Hey Mate") while in Cooking Mode.
2. FR2: Recognize core voice intents: next/previous step, repeat, start/pause/stop timer <label>, remaining time, set custom timer <duration>, help.
3. FR3: Auto‑create timers from recipe timing metadata and display them with labels.
4. FR4: Orchestrate overlapping timers and propose optimal start times for dependent steps.
5. FR5: Provide adaptive step progression based on user voice input and timer states.
6. FR6: Show concise step card with instruction and highlighted ingredients.
7. FR7: Offer curated, searchable recipe catalog (≥100) optimized for Cooking Mode with timing metadata.
8. FR8: Enable offline access to selected recipes and active cooking sessions.
9. FR9: Implement authentication via Supabase with progress/preferences sync.
10. FR10: Provide basic shopping list: add ingredients, view quantities, edit/check items.
11. FR11: Send local notifications and voice announcements for timer thresholds and completions.
12. FR12: Capture analytics on voice intent success, step completion, and session outcomes.

### Non Functional (NFR)
1. NFR1: App launch time <2 seconds on reference devices.
2. NFR2: Voice command round‑trip perceived latency <500ms in Cooking Mode.
3. NFR3: Timer accuracy variance <2 seconds under backgrounding conditions.
4. NFR4: Operate core flows offline (active steps, timers, selected recipes).
5. NFR5: Accessibility: large tap targets, high‑contrast option, and voice‑only control path.
6. NFR6: Privacy: process wake word/commands locally when feasible; comply with GDPR.
7. NFR7: Maintain crash‑free sessions rate aligned with store rating ≥4.5.

## User Interface Design Goals

### Overall UX Vision
A calm, voice‑first cooking companion: minimal, high‑contrast step card; persistent timers panel; clear, short prompts designed for quick glance‑ability and hands‑free use.

### Key Interaction Paradigms
- Wake‑word + short voice intents as primary control.
- Step card as the focal point; timers panel secondary but always accessible.
- Contextual ingredient callouts within steps to avoid context switching.

### Core Screens and Views
- Onboarding & Permissions
- Home/Recipes (Browse & Search)
- Recipe Overview (Ingredients/Tools/Prep)
- Cooking Mode (Step Card + Timers)
- Shopping List
- Settings

### Accessibility: WCAG AA

### Branding
- Minimalist, high‑contrast themes suitable for steamy/kitchen lighting; NativeWind tokens to standardize.

### Target Device and Platforms: Mobile Only (Cross‑Platform iOS & Android)

## Technical Assumptions

### Repository Structure: Monorepo

### Service Architecture
Edge‑first mobile app with Expo RN frontend; Supabase for auth, database, and real‑time. Offline‑first caching layer for recipes and sessions; local notifications for timers.

### Testing Requirements
Unit + Integration for timer logic, voice intent parsing, and step progression; smoke tests for flows; manual kitchen‑noise validation in beta.

### Additional Technical Assumptions and Requests
- TypeScript, React Context + custom hooks for state.
- Expo Router navigation; deep links for recipes.
- Picovoice Porcupine for wake‑word and command processing.
- Local persistence for offline (SQLite/AsyncStorage via Expo APIs).

## Epic List
1. Epic 1: Foundation & Voice POC – App setup, wake‑word prototype, canary Cooking Mode.
2. Epic 2: Cooking Mode Core – Step guidance, voice intents, step progression.
3. Epic 3: Multi‑Timer Orchestration – Auto‑timers, coordination, notifications.
4. Epic 4: Recipe Catalog & Offline – Curated content, search, offline packs.
5. Epic 5: Auth & Sync – Supabase auth, progress/preferences sync.
6. Epic 6: Analytics & Beta – Telemetry, crash reporting, closed beta rollout.

## Checklist Results Report
(To be populated after running PM checklist with the current PRD.)

## Next Steps

### UX Expert Prompt
"Create a minimal, high‑contrast, voice‑first Cooking Mode UX with a concise step card and persistent timers panel. Ensure hands‑free flows, contextual ingredient callouts, and an onboarding that secures mic/notification permissions with the least friction."

### Architect Prompt
"Design an Expo RN + TypeScript app with Supabase backend and Picovoice wake‑word. Implement offline‑first caching, accurate background‑resilient timers, and local notifications. Provide modular state (Context + hooks), analytics instrumentation, and an architecture that supports incremental rollout of advanced orchestration."
