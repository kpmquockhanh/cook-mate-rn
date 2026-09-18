import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedImageType, pathForImage } from '../src/storage/images.js';
import { normalizeImages } from '../src/crawl/images.js';

const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

test('an object key is derived from the bytes, not the URL', () => {
  // Content-addressed: the same photo reached from two recipes is one object,
  // and re-running the mirror overwrites it with itself.
  assert.equal(pathForImage(BYTES, 'image/png'), pathForImage(BYTES, 'image/png'));
  assert.notEqual(pathForImage(BYTES, 'image/png'), pathForImage(new Uint8Array([1]), 'image/png'));
});

test('the key is two-character sharded and carries the real extension', () => {
  const path = pathForImage(BYTES, 'image/webp');
  assert.match(path, /^[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/);
  assert.equal(path.slice(0, 2), path.slice(3, 5));
});

test('a content type with parameters is still recognised', () => {
  assert.ok(isSupportedImageType('image/jpeg; charset=binary'));
  assert.ok(isSupportedImageType('IMAGE/JPEG'));
});

test('an HTML error page served as a 200 is not an image', () => {
  // The failure this guards: storing the bytes of an error page under an
  // image key puts a broken picture in the app and a lie in the database.
  assert.equal(isSupportedImageType('text/html'), false);
  assert.equal(isSupportedImageType('application/pdf'), false);
});

test('CDN resize variants of one photo mirror once', () => {
  const urls = [
    'https://cdn.example.com/hero.jpg',
    'https://cdn.example.com/hero.jpg?resize=500%2C500',
    'https://cdn.example.com/other.jpg',
  ];
  assert.deepEqual(normalizeImages(urls), [
    'https://cdn.example.com/hero.jpg',
    'https://cdn.example.com/other.jpg',
  ]);
});
