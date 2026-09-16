import * as cheerio from 'cheerio';
import type { ExtractedRecipe } from '../types.js';
import { collapseWhitespace, decodeEntities } from '../util.js';
import { normalizeImages } from './images.js';

/** schema.org values are maddeningly polymorphic: string | object | array of either. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return collapseWhitespace(decodeEntities(value));
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // { "@type": "Person", "name": "..." } and { "@value": "..." }
    for (const key of ['name', 'text', '@value', 'url']) {
      const nested = record[key];
      if (typeof nested === 'string') return collapseWhitespace(decodeEntities(nested));
    }
  }
  return undefined;
}

function typeIncludesRecipe(node: Record<string, unknown>): boolean {
  return asArray(node['@type'] as string | string[] | undefined).some(
    (t) => typeof t === 'string' && t.toLowerCase() === 'recipe',
  );
}

/** Walk @graph / arrays / nested objects and collect every Recipe node. */
function collectRecipeNodes(input: unknown, found: Record<string, unknown>[] = []) {
  if (Array.isArray(input)) {
    for (const item of input) collectRecipeNodes(item, found);
    return found;
  }
  if (!input || typeof input !== 'object') return found;
  const node = input as Record<string, unknown>;
  if (typeIncludesRecipe(node)) found.push(node);
  if (node['@graph']) collectRecipeNodes(node['@graph'], found);
  return found;
}

/**
 * recipeInstructions is the messiest field in the wild. It can be:
 *   - a single string of prose
 *   - string[]
 *   - HowToStep[]
 *   - HowToSection[] each with an `itemListElement` of HowToStep[]
 */
function flattenInstructions(value: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (!node) return;
    if (typeof node === 'string') {
      const text = collapseWhitespace(decodeEntities(stripTags(node)));
      if (text) out.push(text);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      const nested = record['itemListElement'] ?? record['steps'];
      if (nested) {
        visit(nested);
        return;
      }
      const text = record['text'] ?? record['name'] ?? record['description'];
      if (typeof text === 'string') {
        const clean = collapseWhitespace(decodeEntities(stripTags(text)));
        if (clean) out.push(clean);
      }
    }
  };
  visit(value);
  return out;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function ratingOf(node: Record<string, unknown>): { value?: number; count?: number } {
  const aggregate = asArray(node['aggregateRating'] as unknown)[0];
  if (!aggregate || typeof aggregate !== 'object') return {};
  const record = aggregate as Record<string, unknown>;
  const value = Number.parseFloat(String(record['ratingValue'] ?? ''));
  const count = Number.parseInt(
    String(record['ratingCount'] ?? record['reviewCount'] ?? ''),
    10,
  );
  return {
    value: Number.isFinite(value) ? value : undefined,
    count: Number.isFinite(count) ? count : undefined,
  };
}

function imagesOf(node: Record<string, unknown>): string[] {
  const raw = asArray(node['image'] as unknown);
  const urls: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') urls.push(entry);
    else if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const url = record['url'] ?? record['contentUrl'];
      if (typeof url === 'string') urls.push(url);
    }
  }
  return normalizeImages(urls);
}

function toExtracted(node: Record<string, unknown>): ExtractedRecipe {
  const rating = ratingOf(node);
  const keywordsRaw = node['keywords'];
  const keywords =
    typeof keywordsRaw === 'string'
      ? keywordsRaw.split(',').map((k) => k.trim()).filter(Boolean)
      : asArray(keywordsRaw as string[]).filter((k): k is string => typeof k === 'string');

  return {
    name: asText(node['name']),
    description: asText(node['description']),
    image: imagesOf(node),
    recipeYield: asText(asArray(node['recipeYield'] as unknown)[0]),
    recipeIngredient: asArray(
      (node['recipeIngredient'] ?? node['ingredients']) as unknown,
    )
      .map((i) => asText(i))
      .filter((i): i is string => Boolean(i)),
    recipeInstructions: flattenInstructions(node['recipeInstructions']),
    totalTime: asText(node['totalTime']),
    prepTime: asText(node['prepTime']),
    cookTime: asText(node['cookTime']),
    recipeCuisine: asText(asArray(node['recipeCuisine'] as unknown)[0]),
    recipeCategory: asText(asArray(node['recipeCategory'] as unknown)[0]),
    keywords,
    ratingValue: rating.value,
    ratingCount: rating.count,
    author: asText(asArray(node['author'] as unknown)[0]),
  };
}

/** Tier A: the schema.org/Recipe JSON-LD block ~80% of recipe sites ship for SEO. */
export function extractJsonLd(html: string): ExtractedRecipe | null {
  const $ = cheerio.load(html);
  const nodes: Record<string, unknown>[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).text();
    if (!raw.trim()) return;
    try {
      collectRecipeNodes(JSON.parse(raw), nodes);
    } catch {
      // Some sites emit JSON-LD with trailing commas or stray newlines in strings.
      try {
        collectRecipeNodes(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')), nodes);
      } catch {
        /* unrecoverable - fall through to the next tier */
      }
    }
  });

  if (nodes.length === 0) return null;

  // Prefer the node with the most ingredients: pages sometimes carry a stub
  // Recipe in a breadcrumb/carousel alongside the real one.
  const best = nodes
    .map(toExtracted)
    .sort((a, b) => (b.recipeIngredient?.length ?? 0) - (a.recipeIngredient?.length ?? 0))[0]!;

  return best.recipeIngredient && best.recipeIngredient.length > 0 ? best : null;
}
