import * as cheerio from 'cheerio';
import type { ExtractedRecipe } from '../../types.js';
import { collapseWhitespace } from '../../util.js';
import { registerAdapter } from './index.js';

/**
 * TEMPLATE for a tier-C site adapter. Copy this file, change `domain` and the
 * selectors, then import it from `src/crawl/adapters/index.ts` so it registers.
 *
 * Only write one after `npm run crawl -- --report` shows a domain you care
 * about repeatedly defeating tiers A and B. Tier C is maintenance debt: these
 * selectors break whenever the site redesigns, and the generic extractors do
 * not.
 *
 * Return null rather than a half-empty object when the page does not match -
 * `extractRecipe` treats null as "no recipe here" and records the failure,
 * which keeps the report honest.
 */
registerAdapter({
  domain: 'example.com',

  extract(html: string): ExtractedRecipe | null {
    const $ = cheerio.load(html);

    const name = collapseWhitespace($('h1.recipe-title').first().text());
    const ingredients = $('.ingredient-list li')
      .map((_, el) => collapseWhitespace($(el).text()))
      .get()
      .filter(Boolean);

    if (!name || ingredients.length === 0) return null;

    return {
      name,
      description: collapseWhitespace($('.recipe-summary').first().text()) || undefined,
      image: $('.recipe-hero img')
        .map((_, el) => $(el).attr('src'))
        .get()
        .filter((src): src is string => Boolean(src) && /^https?:\/\//.test(src)),
      recipeYield: collapseWhitespace($('.recipe-yield').first().text()) || undefined,
      recipeIngredient: ingredients,
      recipeInstructions: $('.instruction-list li')
        .map((_, el) => collapseWhitespace($(el).text()))
        .get()
        .filter(Boolean),
      // Leave times as raw human strings - parseHumanDuration handles them.
      totalTime: collapseWhitespace($('.total-time').first().text()) || undefined,
    };
  },
});
