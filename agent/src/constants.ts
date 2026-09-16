/**
 * Naming the worker switches it from automatic to *explicit* dispatch: it will
 * only join rooms that ask for it by name, instead of every room in the project.
 *
 * Callers request it by putting a matching agent dispatch in the access token's
 * roomConfig. Both token issuers must use this exact name:
 *   - supabase/functions/livekit-token/index.ts  (real sessions)
 *   - src/generate-token.ts                      (local dev)
 *
 * Change it in one place and the others stop dispatching - the room connects
 * fine and no agent ever joins.
 */
export const AGENT_NAME = 'cookmate';
