/**
 * EVERY assumption about the app's published schema lives in this one file.
 *
 * These names are inferred from what the RN app actually reads:
 *   hooks/useRecipe.ts            -> ingredient_text, instruction_text, note_text, image_path
 *   app/(tabs)/recipe/[id].tsx    -> images[].image_path, notes[].note_text
 *   app/cooking/[id].tsx          -> instructions[].duration, .ingredients[]
 *
 * If your backend uses different names, change them here and nowhere else.
 * Run `npm run publish -- --check` to have the publisher introspect the live
 * database and tell you exactly which of these do not exist.
 */
export const MAPPING = {
  recipes: {
    table: 'public.recipes',
    columns: {
      id: 'id',
      title: 'title',
      description: 'description',
      thumbnail: 'thumbnail',
      cookingTime: 'cooking_time',
      servings: 'servings',
      difficulty: 'difficulty',
      rating: 'rating',
      aiScore: 'ai_score',
      reviewCount: 'review_count',
      category: 'category',
      cuisine: 'cuisine',
      // Derived at publish time by publish/facets.ts - see migration 0012.
      totalTimeSeconds: 'total_time_seconds',
      activeTimeSeconds: 'active_time_seconds',
      meal: 'meal',
      mainIngredient: 'main_ingredient',
      diet: 'diet',
      sourceUrl: 'source_url',
      sourceName: 'source_name',
      sourceLicense: 'source_license',
      urlHash: 'url_hash',
      contentFingerprint: 'content_fingerprint',
      qualityScore: 'quality_score',
      enrichmentVersion: 'enrichment_version',
      crawledAt: 'crawled_at',
      publishedAt: 'published_at',
    },
  },
  images: {
    table: 'public.recipe_images',
    columns: { recipeId: 'recipe_id', imagePath: 'image_path', sortOrder: 'sort_order' },
  },
  ingredients: {
    table: 'public.recipe_ingredients',
    columns: {
      recipeId: 'recipe_id',
      ingredientText: 'ingredient_text',
      amount: 'amount',
      sortOrder: 'sort_order',
      canonicalId: 'canonical_id',
      qty: 'qty',
      unit: 'unit',
      qtyGrams: 'qty_grams',
    },
  },
  instructions: {
    table: 'public.recipe_instructions',
    columns: {
      recipeId: 'recipe_id',
      instructionText: 'instruction_text',
      ingredients: 'ingredients',
      duration: 'duration',
      timerName: 'timer_name',
      sortOrder: 'sort_order',
    },
  },
  notes: {
    table: 'public.recipe_notes',
    columns: { recipeId: 'recipe_id', noteText: 'note_text', sortOrder: 'sort_order' },
  },
} as const;

export type Mapping = typeof MAPPING;

/**
 * The translation overlay (migration 0015), kept apart from MAPPING because
 * the publisher does not write it - the translation stage does, and the API
 * reads it. Preflight still checks it, so a half-applied migration is caught
 * by `npm run publish -- --check` rather than by a blank recipe screen.
 *
 * Children are keyed by (recipeId, locale, sortOrder), not by the child row's
 * id: publish/run.ts replaces every child row on each publish, so child ids do
 * not survive a republish and `sort_order` is the only stable handle.
 */
export const TRANSLATION_MAPPING = {
  recipe: {
    table: 'public.recipe_translations',
    columns: {
      recipeId: 'recipe_id',
      locale: 'locale',
      title: 'title',
      description: 'description',
      cuisine: 'cuisine',
      sourceFingerprint: 'source_fingerprint',
      // Migration 0016: the lever that re-runs the stage after a prompt change.
      translationVersion: 'translation_version',
      model: 'model',
      translatedAt: 'translated_at',
    },
  },
  ingredients: {
    table: 'public.recipe_ingredient_translations',
    columns: {
      recipeId: 'recipe_id',
      locale: 'locale',
      sortOrder: 'sort_order',
      ingredientText: 'ingredient_text',
      amount: 'amount',
    },
  },
  instructions: {
    table: 'public.recipe_instruction_translations',
    columns: {
      recipeId: 'recipe_id',
      locale: 'locale',
      sortOrder: 'sort_order',
      instructionText: 'instruction_text',
      timerName: 'timer_name',
      ingredients: 'ingredients',
    },
  },
  notes: {
    table: 'public.recipe_note_translations',
    columns: {
      recipeId: 'recipe_id',
      locale: 'locale',
      sortOrder: 'sort_order',
      noteText: 'note_text',
    },
  },
} as const;

export type TranslationMapping = typeof TRANSLATION_MAPPING;
