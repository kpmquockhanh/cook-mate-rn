/** schema.org-shaped output of the extractor tier that won for a page. */
export interface ExtractedRecipe {
  name?: string;
  description?: string;
  image?: string[];
  recipeYield?: string;
  recipeIngredient?: string[];
  recipeInstructions?: string[];
  totalTime?: string;
  prepTime?: string;
  cookTime?: string;
  recipeCuisine?: string;
  recipeCategory?: string;
  keywords?: string[];
  ratingValue?: number;
  ratingCount?: number;
  author?: string;
}

/** One ingredient after deterministic parsing (stage 1). */
export interface ParsedIngredient {
  index: number;
  raw: string;
  qty: number | null;
  qtyMax: number | null;
  unit: string | null;
  name: string;
  prep: string | null;
  note: string | null;
  optional: boolean;
  qtyGrams: number | null;
  canonicalId: number | null;
  canonicalSlug: string | null;
  matchConfidence: number;
}

export interface ParsedStep {
  index: number;
  text: string;
}

/** Output of stage 2 (LLM). Indices refer to positions in `ingredients`. */
export interface EnrichedStep {
  index: number;
  text: string;
  ingredientIndices: number[];
  durationSeconds: number | null;
  timerName: string | null;
  isPassive: boolean;
}

/** When a dish is eaten. 'basics' is a component - a sauce, a stock, a frosting. */
export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'dessert' | 'snack' | 'basics';

export interface EnrichmentResult {
  steps: EnrichedStep[];
  notes: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  /** Absent on rows enriched before enrichment version 2. */
  meal?: Meal;
  /** The model's reading, used when the scrape left `cuisine` null. */
  cuisine?: string | null;
  servings: number | null;
  totalTimeSeconds: number | null;
  /** The model's own 0-10 quality judgment, distinct from the scraped source rating. */
  aiScore: number;
}

export interface StagingRow {
  id: number;
  raw_page_id: number;
  url_hash: string;
  source_url: string;
  source_id: number | null;
  title: string | null;
  description: string | null;
  image_url: string | null;
  image_urls: string[];
  /** Object paths in our own bucket, once the mirror stage has run. */
  image_paths: string[];
  servings: number | null;
  total_time_seconds: number | null;
  prep_time_seconds: number | null;
  cook_time_seconds: number | null;
  cuisine: string | null;
  category: string | null;
  keywords: string[];
  source_rating: number | null;
  source_review_count: number | null;
  ingredients: ParsedIngredient[];
  steps: ParsedStep[];
  enriched: EnrichmentResult | null;
  enrichment_version: number | null;
  enrichment_model: string | null;
  content_fingerprint: string | null;
  quality_score: number | null;
  quality_issues: QualityIssue[];
  status: 'parsed' | 'enriched' | 'review' | 'approved' | 'published' | 'rejected';
  edited_by_human: boolean;
  published_recipe_id: number | null;
}

export interface QualityIssue {
  code: string;
  severity: 'fatal' | 'major' | 'minor';
  message: string;
}
