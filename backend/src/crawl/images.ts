/**
 * Recipe sites commonly list the same photo several times in one JSON-LD
 * `image` array, once per CDN resize preset:
 *
 *   .../Corn-Chowder-11-SQ.jpg
 *   .../Corn-Chowder-11-SQ.jpg?resize=500%2C500
 *   .../Corn-Chowder-11-SQ.jpg?resize=480%2C270
 *
 * Kept as-is those become four identical thumbnails in the app's gallery. Key
 * on origin + path so only genuinely different photos survive, and keep the
 * first occurrence, which is the unresized original.
 */
export function normalizeImages(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue;

    let key: string;
    try {
      const parsed = new URL(url);
      key = `${parsed.origin}${parsed.pathname}`;
    } catch {
      key = url;
    }

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }

  return out;
}
