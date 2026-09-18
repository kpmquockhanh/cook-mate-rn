import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see crawler/.env.example)`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Default model pair per provider: the cheap workhorse, and the stronger tier
 * `enrich --escalate` falls back to. ENRICH_MODEL / ENRICH_ESCALATION_MODEL
 * override either one, but the defaults must track ENRICH_PROVIDER - a
 * DeepSeek endpoint given a Claude model id just 404s.
 */
const PROVIDER_MODELS = {
  anthropic: { model: 'claude-haiku-4-5', escalation: 'claude-opus-5', prefix: 'claude-' },
  deepseek: { model: 'deepseek-flash', escalation: 'deepseek-v4-pro', prefix: 'deepseek-' },
} as const;

type ProviderKey = keyof typeof PROVIDER_MODELS;

/**
 * An override left over from the other provider is the likeliest way to
 * misconfigure this, and the symptom is an opaque 404 from a vendor that has
 * never heard of the model. Fail here instead, naming the variable to fix.
 */
function resolveModel(name: string, key: ProviderKey, fallback: string): string {
  const override = process.env[name];
  if (!override) return fallback;

  const { prefix } = PROVIDER_MODELS[key];
  if (!override.startsWith(prefix)) {
    throw new Error(
      `${name}="${override}" does not look like a ${key} model (expected a "${prefix}" prefix). ` +
        `Either unset ${name} to use the ${key} default "${fallback}", or set ENRICH_PROVIDER to the matching provider.`,
    );
  }
  return override;
}

function provider(): ProviderKey {
  const raw = (process.env.ENRICH_PROVIDER ?? 'anthropic').toLowerCase();
  if (!(raw in PROVIDER_MODELS)) {
    throw new Error(
      `Unknown ENRICH_PROVIDER "${raw}" (expected one of ${Object.keys(PROVIDER_MODELS).join(', ')})`,
    );
  }
  return raw as ProviderKey;
}

export const env = {
  get databaseUrl() {
    return required('DATABASE_URL');
  },
  // A Supabase pooler in a distant region can take several seconds to accept a
  // connection. Too tight a timeout does not protect anything - it just turns
  // ordinary latency into a failed request.
  dbConnectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', 30000),
  get anthropicApiKey() {
    return required('ANTHROPIC_API_KEY');
  },
  get deepseekApiKey() {
    return required('DEEPSEEK_API_KEY');
  },
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',

  // Getters, not values: the pipeline stages that never enrich must not pay
  // for a provider misconfiguration they do not use.
  get enrichProvider(): ProviderKey {
    return provider();
  },
  get enrichModel() {
    const key = provider();
    return resolveModel('ENRICH_MODEL', key, PROVIDER_MODELS[key].model);
  },
  get enrichEscalationModel() {
    const key = provider();
    return resolveModel('ENRICH_ESCALATION_MODEL', key, PROVIDER_MODELS[key].escalation);
  },
  enrichmentVersion: int('ENRICHMENT_VERSION', 1),

  // ---- Tier D extraction (src/crawl/prose.ts) ----
  // Reads pages the free tiers could not, so it costs money per page and is
  // budgeted rather than run over everything.
  get extractModel() {
    const key = provider();
    return resolveModel('EXTRACT_MODEL', key, PROVIDER_MODELS[key].model);
  },
  // Bump to re-run extraction over stored pages after changing the prompt -
  // the same lever ENRICHMENT_VERSION is for the stage after it.
  extractionVersion: int('EXTRACTION_VERSION', 1),
  // A hard ceiling per run, independent of --limit, so a mistyped limit cannot
  // spend the month's budget in one command.
  extractMaxPagesPerRun: int('EXTRACT_MAX_PAGES_PER_RUN', 200),
  // Page text sent to the model. Recipes sit well inside this; the cap is
  // there so one pathological page cannot cost twenty normal ones.
  extractMaxChars: int('EXTRACT_MAX_CHARS', 24000),
  userAgent:
    process.env.CRAWL_USER_AGENT ??
    'CookMateBot/1.0 (+https://cookmate.app/bot; contact@cookmate.app)',
  crawlConcurrency: int('CRAWL_CONCURRENCY', 4),
  crawlDefaultDelayMs: int('CRAWL_DEFAULT_DELAY_MS', 2000),
  crawlTimeoutMs: int('CRAWL_TIMEOUT_MS', 20000),
  // How long a claimed queue row may stay 'fetching' before the next run
  // assumes the worker holding it died and takes it back.
  crawlLockLeaseMinutes: int('CRAWL_LOCK_LEASE_MINUTES', 15),
  // A server asking us to wait can ask for a long time. Honour it, but not
  // past the point where the run is just sleeping.
  crawlMaxRetryAfterMs: int('CRAWL_MAX_RETRY_AFTER_MS', 300000),
  qualityMinScore: int('QUALITY_MIN_SCORE', 70),
  reviewPort: int('REVIEW_PORT', 5174),
  // 127.0.0.1 by default: the console has no business being reachable from
  // outside the machine it runs on. Docker sets this to 0.0.0.0 because the
  // container's loopback isn't reachable through a published port either way,
  // which is exactly why REVIEW_USERNAME/REVIEW_PASSWORD are not optional.
  reviewHost: process.env.REVIEW_HOST ?? '127.0.0.1',
  // Basic Auth for the pipeline console (src/ui/server.ts). It can start
  // crawls and spend model budget, so it is never served unauthenticated.
  reviewUsername: process.env.REVIEW_USERNAME,
  reviewPassword: process.env.REVIEW_PASSWORD,

  // ---- API (src/api) ----
  apiPort: int('API_PORT', 8787),

  // ---- Auth (src/api/auth.ts) ----
  // Project URL, e.g. https://PROJECT.supabase.co. It gives us both the JWKS
  // endpoint for asymmetric signing keys and the expected `iss`. Optional only
  // because a project still on the legacy HS256 secret needs the secret
  // instead; the API refuses to boot with neither (see assertAuthConfigured).
  supabaseUrl: process.env.SUPABASE_URL?.replace(/\/$/, ''),
  // Legacy HS256 project JWT secret. Not the publishable key and not the
  // service-role key - those are API keys, not signing material.
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET,

  // ---- Raw page storage (src/storage/pages.ts) ----
  // Crawled HTML lives in object storage, not in a Postgres column: it is the
  // largest thing the pipeline keeps and the least often read.
  //
  // The service-role key, not the publishable one - the crawler writes to a
  // bucket the app's users have no access to.
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  rawPageBucket: process.env.RAW_PAGE_BUCKET ?? 'raw-pages',
  // `file` keeps pages on disk instead, for local work and for tests, which
  // must not need a Supabase project to run. Deployments use the default.
  rawPageStore: (process.env.RAW_PAGE_STORE ?? 'supabase').toLowerCase(),
  rawPageDir: process.env.RAW_PAGE_DIR ?? '.raw-pages',

  // ---- Recipe images (src/storage/images.ts) ----
  // A PUBLIC bucket, unlike raw pages: the app loads these straight from an
  // <Image> tag with no session, and EXPO_PUBLIC_STORAGE_URL points at it.
  recipeImageBucket: process.env.RECIPE_IMAGE_BUCKET ?? 'recipe-images',
  // Recipe photos are hero shots, not posters. Anything larger is a mistake -
  // a PDF, a video, a page served as an image - and not worth the bandwidth.
  imageMaxBytes: int('IMAGE_MAX_BYTES', 8 * 1024 * 1024),
  // How many photos per recipe to mirror. The first is the thumbnail; the rest
  // fill the detail screen's gallery, which shows a handful at most.
  imagesPerRecipe: int('IMAGES_PER_RECIPE', 5),

  // 0.0.0.0 so a phone running the Expo app can reach it over the LAN. The
  // review UI binds localhost on purpose; this one is meant to be called.
  apiHost: process.env.API_HOST ?? '0.0.0.0',
  // '*' is fine for local dev. Set an explicit origin in production.
  apiCorsOrigin: process.env.API_CORS_ORIGIN ?? '*',
};
