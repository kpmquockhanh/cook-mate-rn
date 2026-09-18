import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { classifyUrl, decodeSitemap, extractLinks, parseSitemap } from '../src/crawl/discover.js';

test('classifies the URL shapes a recipe site actually uses', () => {
  // Named recipe section plus a slug: the high-confidence case, queued without
  // spending a fetch on it.
  assert.equal(classifyUrl('https://example.com/recipes/roast-chicken'), 'recipe');
  assert.equal(classifyUrl('https://example.com/recipe/12345/apple-pie'), 'recipe');
  assert.equal(classifyUrl('https://example.com/rezepte/kartoffelsalat-mit-speck'), 'recipe');
  assert.equal(classifyUrl('https://example.com/cong-thuc/ga-kho-gung'), 'recipe');

  // A slug with nothing naming it: worth a fetch, which settles the question.
  assert.equal(classifyUrl('https://example.com/blog-post-about-bread'), 'maybe');
  assert.equal(classifyUrl('https://example.com/2024/03/sourdough-starter'), 'maybe');

  // Listing pages: follow for links, never a recipe themselves.
  assert.equal(classifyUrl('https://example.com/'), 'hub');
  assert.equal(classifyUrl('https://example.com/recipes'), 'hub');
  assert.equal(classifyUrl('https://example.com/category/desserts'), 'hub');
  assert.equal(classifyUrl('https://example.com/recipes/category/quick-dinners'), 'hub');

  // Nothing here is ever a recipe.
  assert.equal(classifyUrl('https://example.com/about-us'), 'skip');
  assert.equal(classifyUrl('https://example.com/wp-admin/edit.php'), 'skip');
  assert.equal(classifyUrl('https://example.com/img/hero-shot.jpg'), 'skip');
  assert.equal(classifyUrl('https://example.com/feed'), 'skip');
  assert.equal(classifyUrl('mailto:chef@example.com'), 'skip');
  assert.equal(classifyUrl('not a url at all'), 'skip');
});

test('a bare id or date is not a slug, so it is not a recipe', () => {
  // Hyphens alone do not make a slug - a date has no word in it.
  assert.equal(classifyUrl('https://example.com/2024-03-14'), 'hub');
  assert.equal(classifyUrl('https://example.com/p/99'), 'hub');
  assert.equal(classifyUrl('https://example.com/12345'), 'hub');
});

test('a blog section still holds recipes, a taxonomy never does', () => {
  assert.equal(classifyUrl('https://example.com/blog'), 'hub');
  assert.equal(classifyUrl('https://example.com/blog/sourdough-starter'), 'maybe');
  assert.equal(classifyUrl('https://example.com/recipes/tag/gluten-free'), 'hub');
  assert.equal(classifyUrl('https://example.com/cuisine/thai-street-food'), 'hub');
});

test('reads both sitemap shapes', () => {
  const index = `<?xml version="1.0" encoding="UTF-8"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-recipes.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
    </sitemapindex>`;
  assert.deepEqual(parseSitemap(index), {
    nested: ['https://example.com/sitemap-recipes.xml', 'https://example.com/sitemap-pages.xml'],
    pageUrls: [],
  });

  const urlset = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/recipes/roast-chicken</loc><lastmod>2024-01-01</lastmod></url>
      <url><loc>https://example.com/about-us</loc></url>
    </urlset>`;
  assert.deepEqual(parseSitemap(urlset).pageUrls, [
    'https://example.com/recipes/roast-chicken',
    'https://example.com/about-us',
  ]);

  // A 404 page served as XML, or anything else unexpected, yields nothing
  // rather than throwing halfway through a discovery run.
  assert.deepEqual(parseSitemap('<html><body>Not found</body></html>'), {
    nested: [],
    pageUrls: [],
  });
});

test('resolves page links the way a browser would', () => {
  const html = `
    <a href="/recipes/roast-chicken">Roast chicken</a>
    <a href="recipes/apple-pie">Apple pie</a>
    <a href="https://example.com/recipes/roast-chicken?utm_source=twitter#notes">same recipe</a>
    <a href="//cdn.example.com/asset.js">protocol relative</a>
    <a href="#top">anchor</a>
    <a href="mailto:chef@example.com">mail</a>
    <a href="javascript:void(0)">js</a>
    <a>no href</a>`;
  const links = extractLinks(html, 'https://example.com/browse/');

  // The tracking parameter and the fragment collapse into the canonical URL,
  // so one recipe linked three ways is one candidate, not three.
  assert.equal(links.filter((l) => l.endsWith('/recipes/roast-chicken')).length, 1);
  assert.ok(links.includes('https://example.com/browse/recipes/apple-pie'));
  assert.ok(links.some((l) => l.includes('cdn.example.com')));
  assert.ok(!links.some((l) => l.startsWith('mailto:') || l.startsWith('javascript:')));
  assert.ok(!links.some((l) => l.includes('#')));
});

test('a gzipped sitemap is read, not discarded', () => {
  const xml =
    '<?xml version="1.0"?><urlset><url><loc>https://example.com/recipes/pho-bo</loc></url>' +
    '<url><loc>https://example.com/recipes/banh-mi</loc></url></urlset>';

  // Served as `application/gzip`: raw deflate bytes `fetch` has not touched.
  const gzipped = gzipSync(Buffer.from(xml, 'utf8'));
  assert.equal(decodeSitemap(new Uint8Array(gzipped)), xml);

  // Served as `Content-Encoding: gzip`: already decompressed by the time we see
  // it. Keying on the magic number rather than the `.gz` in the URL means both
  // arrive at the same place.
  assert.equal(decodeSitemap(new Uint8Array(Buffer.from(xml, 'utf8'))), xml);

  const { pageUrls } = parseSitemap(decodeSitemap(new Uint8Array(gzipped)));
  assert.deepEqual(pageUrls, [
    'https://example.com/recipes/pho-bo',
    'https://example.com/recipes/banh-mi',
  ]);
});

test('an empty or truncated body decodes to something parseSitemap can refuse', () => {
  assert.equal(decodeSitemap(new Uint8Array([])), '');
  const { nested, pageUrls } = parseSitemap(decodeSitemap(new Uint8Array([])));
  assert.deepEqual(nested, []);
  assert.deepEqual(pageUrls, []);
});
