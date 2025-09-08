# Product Requirements Document (PRD): CookMate – The Smart Cooking Companion

## 1. Overview

**Product name**: CookMate

**One‑liner**: Voice‑first, hands‑free cooking companion that intelligently orchestrates timers and step guidance to reduce stress and improve cooking outcomes.

**Problem**: Traditional recipe apps are static, require constant screen interaction with messy hands, offer poor timing coordination for concurrent tasks, and don’t adapt to the user’s pace.

**Solution**: An interactive Cooking Mode with wake‑word voice control, intelligent multi‑timer orchestration, and adaptive, step‑by‑step guidance.

**Target platforms**: iOS (14+) and Android (API 23+) using React Native/Expo.

## 2. Goals and Non‑Goals

### 2.1 Business Goals (Year 1)
- 50K downloads in 6 months; 200K by end of year
- 40% MAU retention
- $500K ARR via premium subscriptions
- Category leadership for “cooking companion”

### 2.2 User Goals
- Complete more complex recipes with confidence
- Reduce cooking stress; keep hands free
- Improve timing and coordination across parallel steps

### 2.3 Success Metrics (KPIs)
- DAU: ≥15% of registered users
- Cooking session duration: ~45 minutes
- Voice command success rate: >95%
- Timer accuracy: <2s variance
- Store rating: ≥4.5

### 2.4 Non‑Goals (MVP)
- Recipe authoring/editing tools
- Social/community features and sharing
- Advanced dietary filters and scaling
- Video integration, nutrition tracking, meal planning
- Smart appliance integrations

## 3. Users and Personas

### 3.1 Primary: Engaged Home Cooks (28–45)
- Cook 3–5 meals/week, moderate tech comfort
- Needs: hands‑free guidance, multi‑timer coordination, reduced stress

### 3.2 Secondary: Cooking Enthusiasts & Creators (22–40)
- High social engagement, advanced technique interest
- Needs: precision timing, customization, future sharing integrations

## 4. User Stories (Prioritized)

Must‑have (MVP):
- As a home cook, I can say a wake word to control the app hands‑free during cooking.
- As a user, I can follow a step‑by‑step guided flow for a recipe with clear instructions.
- As a user, I can start, pause, and adjust multiple timers with voice commands.
- As a user, I can ask to repeat the current step or go to the next step via voice.
- As a user, I can see ingredients and quantities surfaced contextually per step.
- As a user, I can sign in and have my progress/preferences synced.
- As a user, I can browse a curated set of recipes optimized for Cooking Mode.

Should‑have (post‑MVP candidates):
- As a user, I can adapt steps to my available time or detect skill level.
- As a user, I can save favorite recipes and track completion history.

## 5. Functional Requirements (MVP)

### 5.1 Cooking Mode
- Wake word detection (“Hey Mate”) always‑listening while in Cooking Mode
- Supported voice intents: next step, previous step, repeat, start/pause/stop timer <name|step>, remaining time, set custom timer <duration>, help
- Step progression adapts to voice input and timer states
- Visual step card with concise instruction and highlighted ingredients

### 5.2 Intelligent Multi‑Timer System
- Auto‑create timers from recipe timing metadata
- Orchestrate overlapping timers; propose optimal start times (e.g., “start rice when chicken has 18m left”)
- Announcements via TTS/voice prompt when timers near completion
- Timer accuracy target: <2s variance; resilient to backgrounding

### 5.3 Recipe Catalog
- 100+ curated recipes with timing metadata optimized for Cooking Mode
- Offline access to selected recipes
- Basic search/filter by category and difficulty

### 5.4 Authentication & Sync
- Email/password or provider login (via Supabase)
- Persist cooking progress and preferences across devices

### 5.5 Shopping List (Basic)
- Add ingredients from a recipe to a simple list; quantity view/edit

## 6. Non‑Functional Requirements
- App launch <2s on reference devices
- Voice command response <500ms
- Offline: core cooking flow, active timers, step instructions available
- Accessibility: large tap targets, high‑contrast option, voice‑only path
- Privacy: process wake word/commands locally when possible; GDPR compliance
- Reliability: handle noisy kitchen environments; degrade gracefully

## 7. Scope for MVP

In scope:
- Cooking Mode (voice intents above), multi‑timer orchestration, curated recipe set, basic shopping list, authentication, offline core flows

Out of scope:
- Advanced dietary filters, social/sharing, video, nutrition, meal planning, smart appliances, advanced scaling/substitutions

## 8. Experience Design

### 8.1 Core Flows
- Onboarding → permissions (mic/notifications) → sample recipe walkthrough
- Browse/Select recipe → Pre‑cook overview (ingredients/tools) → Start Cooking Mode
- Cooking Mode: step card + timers panel; voice is primary control
- Completion screen: summary, option to save/favorite, quick feedback

### 8.2 Navigation
- Expo Router file‑based routing; tabs for Home, Recipes, Cooking, Settings

### 8.3 Content Design
- Steps under 140 characters; action‑first phrasing; show timing cues inline
- Ingredient callouts per step; avoid context switching

## 9. Technical Architecture

- Frontend: React Native + Expo; TypeScript; NativeWind for styling
- Voice: Picovoice Porcupine for wake‑word + command processing
- Backend: Supabase (auth, DB, real‑time); edge‑first API access
- State: React Context + custom hooks; offline‑first data cache
- Navigation: Expo Router; deep links for recipes
- Notifications: local notifications for timers; background timer resilience

## 10. Data Model (MVP sketch)

- User: id, email, preferences
- Recipe: id, title, ingredients[], steps[], timingMetadata, difficulty, categories
- Step: id, recipeId, order, instruction, durationSec?, ingredientRefs[]
- Timer: id, recipeId, stepId?, label, durationSec, startAt, status
- ShoppingItem: id, recipeId?, name, quantity, unit, checked

## 11. Analytics & Telemetry
- Voice intent success/failure, latency
- Step completion rate and backtracks
- Timer accuracy and adjustments
- Session completion rate; drop‑off step
- Crash‑free sessions; backgrounding resilience

## 12. Constraints & Assumptions
- Solo developer; 6‑month MVP
- Budget ~$50K
- Kitchen noise is common; wake‑word must remain reliable
- Users accept voice in kitchen; smartphone mics are sufficient

## 13. Risks and Mitigations
- Voice accuracy in noisy environments → choose robust wake‑word model; kitchen noise tests
- Multi‑timer complexity → start with deterministic orchestration; expand as validated
- Adoption barrier for voice → provide quick tutorial and mixed‑mode controls
- Competition replication → defensible orchestration UX and metadata pipeline
- Monetization uncertainty → validate premium with paywall experiments post‑MVP

## 14. Open Questions
- Optimal automation vs user control in timer orchestration?
- Minimum viable recipe count for strong retention?
- Which premium features convert best for this audience?
- Offline voice processing coverage vs on‑device constraints?

## 15. Release Plan

Milestones:
- M0: POC wake‑word + sample recipe Cooking Mode
- M1: Multi‑timer orchestration v1; 20 curated recipes; offline cache
- M2: Auth + sync; 60 recipes; onboarding + tutorial
- M3 (MVP): 100+ recipes; analytics; polishing; TestFlight/Closed beta

Rollout:
- Beta with 100–500 users; capture session metrics and surveys
- Iterate on voice intents and step phrasing

## 16. Pricing & Packaging (Initial Hypothesis)
- Free tier: browse, limited Cooking Mode sessions/week
- Premium: unlimited Cooking Mode, advanced timers/alerts, offline packs

## 17. Appendix
- References: Voice UI guidelines; RN performance best practices; Supabase docs; market stats (see Brief)
- Research TODO: competitive analysis of voice cooking apps; pricing studies; kitchen acoustics tests; offline voice feasibility
