import * as cheerio from 'cheerio';
import * as z from 'zod/v4';
import { env } from '../env.js';
import { logger } from '../log.js';
import { activeProvider } from '../enrich/providers/index.js';
import type { ExtractedRecipe } from '../types.js';
import { collapseWhitespace } from '../util.js';
import { normalizeImages } from './images.js';

const log = logger('prose');

// ---------------------------------------------------------------------------
// Tier D: read a recipe out of a page no machine-readable markup describes.
//
// Tiers A-C read structure the page publishes about itself. This one reads the
// page the way a person would, which is why it is last and why it costs money:
// it runs only when JSON-LD, microdata and any site adapter have all missed.
//
// Its input is a page the engine already fetched. It never requests anything
// from a source site, so improving the prompt re-runs over the whole corpus
// without re-crawling - the same property `enrich` has.
// ---------------------------------------------------------------------------

export const ProseRecipeSchema = z.object({
  isRecipe: z
    .boolean()
    .describe(
      'True only if this page contains an actual recipe with ingredients and steps. ' +
        'False for a listing page, an index, a round-up of links, or an article about food ' +
        'that never gives a recipe.',
    ),
  name: z.string().nullable().describe('The dish name as the page gives it'),
  description: z.string().nullable().describe('One sentence, drawn from the page'),
  recipeYield: z.string().nullable().describe('Servings or yield as stated, e.g. "4 servings"'),
  recipeIngredient: z
    .array(z.string())
    .describe(
      'One entry per ingredient line, copied as the page writes it, quantity included. ' +
        'Do not reword, convert, split or merge lines.',
    ),
  recipeInstructions: z
    .array(z.string())
    .describe('The steps in order, one entry each, in the page\'s own words'),
  totalTimeMinutes: z.number().int().nullable(),
  prepTimeMinutes: z.number().int().nullable(),
  cookTimeMinutes: z.number().int().nullable(),
  recipeCuisine: z.string().nullable(),
  recipeCategory: z.string().nullable().describe('e.g. dessert, main course, breakfast'),
});

export type ProsePayload = z.infer<typeof ProseRecipeSchema>;

const SYSTEM = `You read a web page and report the recipe it contains, if it contains one.

The page has already defeated every structured extractor, so it is either a recipe written as
ordinary prose, or not a recipe at all. Both outcomes are useful; guessing is not.

Rules:
- Set isRecipe false whenever the page does not actually give a recipe: a category listing, a
  round-up of links to other recipes, a product page, an essay about a dish that never lists
  ingredients and steps. When isRecipe is false, leave every other field null or empty.
- Copy ingredient lines as the page writes them, including quantities and units. Do not convert
  units, do not reword, do not split one line into two or merge two into one.
- Give the instructions in order, one entry per step, in the page's own words. Do not summarize.
- Never invent an ingredient, a step, a time or a yield the page does not state. If the page does
  not say, the value is null.
- Ignore navigation, comments, subscription prompts, author biography and related-recipe links.
- A page may describe more than one recipe. Report the main one - the one the page is about.`;

const BLOCK_TAGS = 'p,div,li,br,h1,h2,h3,h4,h5,h6,tr,section,article,blockquote';
const NOISE_TAGS = 'script,style,noscript,nav,header,footer,aside,form,iframe,svg,button,select';

/**
 * Reduce a page to the text a reader would see, with block structure preserved
 * as line breaks.
 *
 * Markup is most of a page's bytes and none of its meaning, and an ingredient
 * list is only recognisable as a list if the line breaks survive - flattening
 * everything to one paragraph is what makes a model start inventing structure.
 */
export function htmlToText(html: string, maxChars = env.extractMaxChars): string {
  const $ = cheerio.load(html);
  $(NOISE_TAGS).remove();
  $(BLOCK_TAGS).append('\n');

  const text = ($('body').text() || $.root().text())
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

/** Images from the page's own metadata, so no URL is ever invented by a model. */
function imagesFrom(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const candidates: string[] = [];

  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[name="twitter:image"]',
  ]) {
    const content = $(selector).attr('content');
    if (content) candidates.push(content);
  }

  $('article img, main img, .recipe img').each((_, element) => {
    const src = $(element).attr('src') ?? $(element).attr('data-src');
    if (src) candidates.push(src);
  });

  const absolute = candidates
    .map((src) => {
      try {
        return new URL(src, pageUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((src): src is string => src !== null);

  return normalizeImages(absolute).slice(0, 6);
}

function isoMinutes(minutes: number | null): string | undefined {
  return minutes && minutes > 0 ? `PT${minutes}M` : undefined;
}

/** Words long enough to carry identity, lowercased, for the grounding check. */
function contentWords(line: string): string[] {
  return (line.toLowerCase().match(/[a-zÀ-ɏ]{4,}/g) ?? []);
}

/**
 * Does this output actually come from this page?
 *
 * The schema guarantees shape and the prompt asks for honesty, but neither can
 * stop a model that has decided to write a plausible recipe from nothing. Every
 * ingredient line should have at least one substantial word present in the page
 * text; a line where none appears was not read off the page. Checking words
 * rather than whole lines tolerates the light reformatting the prompt permits,
 * while still catching wholesale invention.
 */
export function groundedIn(pageText: string, lines: string[]): boolean {
  if (lines.length === 0) return false;
  const haystack = pageText.toLowerCase();

  const unsupported = lines.filter((line) => {
    const words = contentWords(line);
    // A line of pure quantities ("2 tbsp") has nothing to check; let it pass.
    if (words.length === 0) return false;
    return !words.some((word) => haystack.includes(word));
  });

  return unsupported.length <= lines.length / 2;
}

export interface ProseOutcome {
  recipe: ExtractedRecipe | null;
  /** Qualified as `provider:model`, so the row records both. */
  model: string;
  /** Why nothing came back, when nothing did. */
  reason?: 'not-a-recipe' | 'too-thin' | 'ungrounded' | 'empty-page';
}

/**
 * Turn the model's answer into the same `ExtractedRecipe` tiers A-C produce.
 *
 * The schema guarantees the shape of the payload; this decides whether it means
 * anything. A page the model declined, a result too thin to be a recipe, and a
 * result that does not appear in the page all end the same way - no extraction -
 * because each of those is better than a fabricated recipe reaching the app.
 */
export function toExtracted(
  payload: ProsePayload,
  pageText: string,
  html: string,
  pageUrl: string,
): { recipe: ExtractedRecipe | null; reason?: ProseOutcome['reason'] } {
  if (!payload.isRecipe) return { recipe: null, reason: 'not-a-recipe' };

  const ingredients = payload.recipeIngredient
    .map((line) => collapseWhitespace(line))
    .filter(Boolean);
  const steps = payload.recipeInstructions.map((line) => collapseWhitespace(line)).filter(Boolean);

  // Below this there is no recipe to publish, whatever the model called it.
  if (ingredients.length < 2 || steps.length < 1) return { recipe: null, reason: 'too-thin' };
  if (!groundedIn(pageText, ingredients)) return { recipe: null, reason: 'ungrounded' };

  return {
    recipe: {
      name: payload.name ? collapseWhitespace(payload.name) : undefined,
      description: payload.description ? collapseWhitespace(payload.description) : undefined,
      image: imagesFrom(html, pageUrl),
      recipeYield: payload.recipeYield ?? undefined,
      recipeIngredient: ingredients,
      recipeInstructions: steps,
      totalTime: isoMinutes(payload.totalTimeMinutes),
      prepTime: isoMinutes(payload.prepTimeMinutes),
      cookTime: isoMinutes(payload.cookTimeMinutes),
      recipeCuisine: payload.recipeCuisine ?? undefined,
      recipeCategory: payload.recipeCategory ?? undefined,
      keywords: [],
      // Deliberately absent: a prose blog states no aggregate rating, and a
      // model asked for one would supply a number nobody measured.
      ratingValue: undefined,
      ratingCount: undefined,
      author: undefined,
    },
    reason: undefined,
  };
}

/** Tier D over one already-fetched page. */
export async function extractProse(html: string, pageUrl: string): Promise<ProseOutcome> {
  const provider = activeProvider();
  const model = env.extractModel;
  const pageText = htmlToText(html);

  if (pageText.length < 200) {
    return { recipe: null, model: `${provider.name}:${model}`, reason: 'empty-page' };
  }

  const response = await provider.complete({
    system: SYSTEM,
    user: `URL: ${pageUrl}\n\nPage text:\n${pageText}`,
    model,
    escalate: false,
    schema: ProseRecipeSchema,
  });

  const { recipe, reason } = toExtracted(response.payload, pageText, html, pageUrl);
  log.debug(
    recipe
      ? `${pageUrl}: ${recipe.recipeIngredient?.length} ingredients, ${recipe.recipeInstructions?.length} steps`
      : `${pageUrl}: no recipe (${reason})`,
  );

  return { recipe, model: `${provider.name}:${response.model}`, reason };
}
