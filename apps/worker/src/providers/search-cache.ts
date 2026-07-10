import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { paths } from '@scriptreel/config';
import { type RawCandidate, SEARCH_CACHE_TTL_H, searchCacheKey } from '@scriptreel/core';

// 24 h disk cache (doc 08 §SearchCache). Hits cost zero quota — this makes
// storyboard re-search and pipeline re-runs nearly free.
interface CacheFile {
  fetchedAt: string;
  candidates: RawCandidate[];
}

function cachePath(provider: string, key: string): string {
  return join(paths.cacheDir, 'search', provider, `${key}.json`);
}

export async function readSearchCache(
  provider: string,
  kind: string,
  orientation: string,
  query: string,
): Promise<RawCandidate[] | null> {
  const path = cachePath(provider, searchCacheKey(provider, kind, orientation, query));
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheFile;
    const ageMs = Date.now() - new Date(parsed.fetchedAt).getTime();
    if (ageMs > SEARCH_CACHE_TTL_H * 3_600_000) return null;
    return parsed.candidates;
  } catch {
    return null; // miss or unreadable
  }
}

export async function writeSearchCache(
  provider: string,
  kind: string,
  orientation: string,
  query: string,
  candidates: RawCandidate[],
): Promise<void> {
  const path = cachePath(provider, searchCacheKey(provider, kind, orientation, query));
  await mkdir(dirname(path), { recursive: true });
  const payload: CacheFile = { fetchedAt: new Date().toISOString(), candidates };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}
