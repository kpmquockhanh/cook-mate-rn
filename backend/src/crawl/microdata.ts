import * as cheerio from 'cheerio';
import type { ExtractedRecipe } from '../types.js';
import { collapseWhitespace, decodeEntities } from '../util.js';
import { normalizeImages } from './images.js';

function prop($: cheerio.CheerioAPI, scope: cheerio.Cheerio<any>, name: string): string[] {
  const values: string[] = [];
  scope.find(`[itemprop="${name}"]`).each((_, element) => {
    const node = $(element);
    const tag = (element as { tagName?: string }).tagName?.toLowerCase();
    let value: string | undefined;
    if (tag === 'meta') value = node.attr('content');
    else if (tag === 'time') value = node.attr('datetime') ?? node.text();
    else if (tag === 'img') value = node.attr('src');
    else if (tag === 'a' && name === 'url') value = node.attr('href');
    else value = node.text();
    if (value) {
      const clean = collapseWhitespace(decodeEntities(value));
      if (clean) values.push(clean);
    }
  });
  return values;
}

/** Tier B: microdata/RDFa fallback for sites that never adopted JSON-LD. */
export function extractMicrodata(html: string): ExtractedRecipe | null {
  const $ = cheerio.load(html);
  const scope = $('[itemtype*="schema.org/Recipe" i]').first();
  if (scope.length === 0) return null;

  const ingredients = [
    ...prop($, scope, 'recipeIngredient'),
    ...prop($, scope, 'ingredients'),
  ];
  if (ingredients.length === 0) return null;

  const ratingValue = Number.parseFloat(prop($, scope, 'ratingValue')[0] ?? '');
  const ratingCount = Number.parseInt(
    prop($, scope, 'ratingCount')[0] ?? prop($, scope, 'reviewCount')[0] ?? '',
    10,
  );

  return {
    name: prop($, scope, 'name')[0],
    description: prop($, scope, 'description')[0],
    image: normalizeImages(prop($, scope, 'image')),
    recipeYield: prop($, scope, 'recipeYield')[0],
    recipeIngredient: ingredients,
    recipeInstructions: prop($, scope, 'recipeInstructions'),
    totalTime: prop($, scope, 'totalTime')[0],
    prepTime: prop($, scope, 'prepTime')[0],
    cookTime: prop($, scope, 'cookTime')[0],
    recipeCuisine: prop($, scope, 'recipeCuisine')[0],
    recipeCategory: prop($, scope, 'recipeCategory')[0],
    keywords: prop($, scope, 'keywords').flatMap((k) => k.split(',').map((x) => x.trim())),
    ratingValue: Number.isFinite(ratingValue) ? ratingValue : undefined,
    ratingCount: Number.isFinite(ratingCount) ? ratingCount : undefined,
    author: prop($, scope, 'author')[0],
  };
}
