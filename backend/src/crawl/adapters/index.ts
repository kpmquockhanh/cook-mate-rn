import type { ExtractedRecipe } from '../../types.js';

export interface SiteAdapter {
  /** Domain this adapter claims, matched against the canonicalized hostname. */
  domain: string;
  extract(html: string, url: string): ExtractedRecipe | null;
}

// Tier C. Register an adapter only when tiers A and B genuinely fail for a
// domain you care about - `npm run crawl -- --report` prints the failures
// ranked by frequency so you know which ones are worth the effort.
//
// To add one: copy `example-template.ts`, then import it here so its
// registerAdapter() call runs:
//   import './allrecipes.js';
const adapters: SiteAdapter[] = [];

export function registerAdapter(adapter: SiteAdapter): void {
  adapters.push(adapter);
}

export function adapterFor(domain: string): SiteAdapter | null {
  return adapters.find((a) => domain === a.domain || domain.endsWith(`.${a.domain}`)) ?? null;
}

export function adapterCount(): number {
  return adapters.length;
}
