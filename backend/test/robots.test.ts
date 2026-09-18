import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedBy, matches, parseRobots, productToken } from '../src/crawl/robots.js';

const ORIGIN = 'https://example.com';
const US = 'cookmatebot';

const allows = (body: string, path: string, token = US) =>
  isAllowedBy(parseRobots(body, ORIGIN, token), path);

test('a trailing $ anchors the end of the path', () => {
  const body = ['User-agent: *', 'Disallow: /*.pdf$'].join('\n');

  // The anchored rule covers the file itself...
  assert.equal(allows(body, '/files/report.pdf'), false);
  assert.equal(allows(body, '/report.pdf'), false);

  // ...and nothing past the end of it. This is the case that regressed: the `$`
  // used to be escaped into a literal, so the pattern matched nothing at all
  // and every one of these came back allowed.
  assert.equal(allows(body, '/files/report.pdf?download=1'), true);
  assert.equal(allows(body, '/files/report.pdf.html'), true);
  assert.equal(allows(body, '/files/report.txt'), true);
});

test('an unanchored pattern is a prefix match, with * spanning any run', () => {
  assert.equal(matches('/private', '/private/recipes/123'), true);
  assert.equal(matches('/a/*/c', '/a/b/c'), true);
  assert.equal(matches('/a/*/c', '/a/b/b/c'), true);
  assert.equal(matches('/a/*/c', '/a/c'), false);

  // Regex metacharacters in a path are literals, not syntax.
  assert.equal(matches('/search?q=', '/search?q=bread'), true);
  assert.equal(matches('/a.b', '/axb'), false);
});

test('consecutive User-agent lines share one group', () => {
  // The rule is addressed to both agents. Reading it as two groups, of which
  // only the last carries rules, loses the Disallow for `*` entirely.
  const body = ['User-agent: *', 'User-agent: googlebot', 'Disallow: /'].join('\n');

  assert.equal(allows(body, '/recipes/roast-chicken'), false);
  assert.equal(allows(body, '/recipes/roast-chicken', 'googlebot'), false);
});

test('a group is claimed only by an exact product token, never a prefix', () => {
  const body = ['User-agent: cook', 'Disallow: /'].join('\n');

  // `cook` is a prefix of `cookmatebot`, and addresses some other crawler.
  assert.equal(allows(body, '/recipes/roast-chicken'), true);

  // The exact token does claim it.
  assert.equal(allows(body, '/recipes/roast-chicken', 'cook'), false);
});

test('our own group wins outright over the wildcard group', () => {
  // A site that shuts out everyone and then lets us in means the exemption to
  // hold. OR-ing the two groups together would re-impose the rule it lifted.
  const body = [
    'User-agent: *',
    'Disallow: /',
    '',
    'User-agent: CookMateBot',
    'Disallow: /admin',
  ].join('\n');

  assert.equal(allows(body, '/recipes/roast-chicken'), true);
  assert.equal(allows(body, '/admin/users'), false);

  // Any other crawler still sees the wildcard group.
  assert.equal(allows(body, '/recipes/roast-chicken', 'someotherbot'), false);
});

test('several records naming us are merged', () => {
  const body = [
    'User-agent: CookMateBot',
    'Disallow: /admin',
    '',
    'User-agent: cookmatebot',
    'Disallow: /drafts',
    'Crawl-delay: 5',
  ].join('\n');

  const rules = parseRobots(body, ORIGIN, US);
  assert.deepEqual(rules.disallow.sort(), ['/admin', '/drafts']);
  assert.equal(rules.crawlDelayMs, 5000);
});

test('longest match wins, and Allow beats Disallow at equal length', () => {
  const body = [
    'User-agent: *',
    'Disallow: /recipes',
    'Allow: /recipes/public',
  ].join('\n');

  assert.equal(allows(body, '/recipes/secret'), false);
  assert.equal(allows(body, '/recipes/public/roast-chicken'), true);

  const tie = ['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n');
  assert.equal(allows(tie, '/x/y'), true);
});

test('an empty Disallow allows everything and still closes the header', () => {
  const body = [
    'User-agent: *',
    'Disallow:',
    'User-agent: otherbot',
    'Disallow: /',
  ].join('\n');

  // The second User-agent line starts a new group rather than joining the
  // first, because a rule line came between them.
  assert.equal(allows(body, '/anything'), true);
  assert.equal(allows(body, '/anything', 'otherbot'), false);
});

test('Sitemap belongs to the file, not to the group it sits in', () => {
  const body = [
    'Sitemap: https://example.com/sitemap.xml',
    'User-agent: someoneelse',
    'Disallow: /',
    'Sitemap: /sitemap-2.xml',
  ].join('\n');

  const rules = parseRobots(body, ORIGIN, US);
  // Read unconditionally, including the one inside a group addressed elsewhere,
  // and resolved against the origin.
  assert.deepEqual(rules.sitemaps, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap-2.xml',
  ]);
});

test('comments, blank lines and rules before any group are ignored', () => {
  const body = [
    '# nothing to see',
    'Disallow: /orphaned',
    '',
    'User-agent: *   # trailing comment',
    'Disallow: /admin  # and here',
  ].join('\n');

  assert.equal(allows(body, '/orphaned'), true);
  assert.equal(allows(body, '/admin'), false);
});

test('a robots.txt with no group for us and no wildcard allows everything', () => {
  const body = ['User-agent: otherbot', 'Disallow: /'].join('\n');
  assert.equal(allows(body, '/recipes/roast-chicken'), true);
});

test('the product token drops the version and the contact suffix', () => {
  assert.equal(productToken('CookMateBot/1.0 (+https://cookmate.app/bot)'), 'cookmatebot');
  assert.equal(productToken('SomeBot'), 'somebot');
});
