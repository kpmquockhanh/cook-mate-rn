/**
 * The storage step of `setup`: make sure both buckets exist, without failing
 * setup on a machine that has no storage credentials yet. When both buckets
 * fail for the same reason (typically "not configured") that is one warning,
 * not two near-identical ones.
 */
export interface StorageSetup {
  info: string[];
  warn: string[];
}

type Ensure = () => Promise<string>;

async function attempt(ensure: Ensure): Promise<{ ok: string } | { error: string }> {
  try {
    return { ok: await ensure() };
  } catch (error) {
    return { error: String(error) };
  }
}

export async function prepareStorage(ensure: {
  pages: Ensure;
  images: Ensure;
}): Promise<StorageSetup> {
  const pages = await attempt(ensure.pages);
  const images = await attempt(ensure.images);

  if ('error' in pages && 'error' in images && pages.error === images.error) {
    return { info: [], warn: [`object storage not ready: ${pages.error}`] };
  }
  const result: StorageSetup = { info: [], warn: [] };
  for (const [label, outcome] of [
    ['page', pages],
    ['image', images],
  ] as const) {
    if ('ok' in outcome) result.info.push(outcome.ok);
    else result.warn.push(`${label} storage not ready: ${outcome.error}`);
  }
  return result;
}
