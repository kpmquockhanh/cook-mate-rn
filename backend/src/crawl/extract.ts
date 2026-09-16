import type { ExtractedRecipe } from '../types.js';
import { domainOf } from '../util.js';
import { adapterFor } from './adapters/index.js';
import { extractJsonLd } from './jsonld.js';
import { extractMicrodata } from './microdata.js';

export interface ExtractionOutcome {
  recipe: ExtractedRecipe | null;
  extractor: string;
}

/**
 * Tier order is cheapest-first: a site-specific adapter only runs when the two
 * generic extractors have both come up empty, so adding an adapter can never
 * silently regress a page that JSON-LD already handled well.
 */
export function extractRecipe(html: string, url: string): ExtractionOutcome {
  const jsonLd = extractJsonLd(html);
  if (jsonLd) return { recipe: jsonLd, extractor: 'jsonld' };

  const microdata = extractMicrodata(html);
  if (microdata) return { recipe: microdata, extractor: 'microdata' };

  const adapter = adapterFor(domainOf(url));
  if (adapter) {
    const adapted = adapter.extract(html, url);
    if (adapted) return { recipe: adapted, extractor: `adapter:${adapter.domain}` };
  }

  return { recipe: null, extractor: 'none' };
}
