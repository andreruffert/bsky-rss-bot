import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FORMAT_VERSION = 1;

/**
 * Read the cache. A missing file is a valid empty cache; other errors are surfaced.
 *
 * @param {string} cacheFile
 * @returns {Promise<import('./types.js').CacheState>}
 */
export async function readCache(cacheFile) {
  let data;

  try {
    data = await readFile(cacheFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { seen: new Set() };

    throw new Error(`Unable to read cache file "${cacheFile}".`, { cause: error });
  }

  let parsed;

  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Cache file "${cacheFile}" contains invalid JSON.`, { cause: error });
  }

  if (Number.isInteger(parsed?.version) && parsed.version > FORMAT_VERSION) {
    throw new Error(
      `Cache file "${cacheFile}" uses format ${parsed.version}, which was created by a newer version of bsky-rss-bot (this version supports format ${FORMAT_VERSION}).`,
    );
  }

  if (
    parsed?.version !== FORMAT_VERSION ||
    !Array.isArray(parsed.seen) ||
    !parsed.seen.every((key) => typeof key === 'string')
  ) {
    throw new Error(`Cache file "${cacheFile}" has an unsupported format.`);
  }

  return {
    seen: new Set(parsed.seen),
    etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
    lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified : undefined,
  };
}

/**
 * Atomically write the cache, keeping only the `limit` most recently added keys.
 *
 * @param {string} cacheFile
 * @param {import('./types.js').CacheState} cache
 * @param {number} limit
 * @returns {Promise<void>}
 */
export async function writeCache(cacheFile, { seen, etag, lastModified }, limit) {
  const body = JSON.stringify({
    version: FORMAT_VERSION,
    seen: [...seen].slice(Math.max(0, seen.size - limit)),
    etag,
    lastModified,
  });

  const target = path.resolve(cacheFile);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});

    throw new Error(`Unable to write cache file "${target}".`, { cause: error });
  }
}
