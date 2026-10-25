import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readCache, writeCache } from '../src/cache.js';

async function withTempDir(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bsky-rss-bot-test-'));

  try {
    await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('readCache returns an empty cache when the file does not exist', async () => {
  await withTempDir(async (directory) => {
    const cache = await readCache(path.join(directory, 'cache.json'));

    assert.deepEqual([...cache.seen], []);
    assert.equal(cache.etag, undefined);
    assert.equal(cache.lastModified, undefined);
  });
});

test('writeCache and readCache round-trip keys and validators', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'nested', 'cache.json');

    await writeCache(file, { seen: new Set(['a', 'b']), etag: '"x"', lastModified: 'today' }, 10);

    const cache = await readCache(file);

    assert.deepEqual([...cache.seen], ['a', 'b']);
    assert.equal(cache.etag, '"x"');
    assert.equal(cache.lastModified, 'today');
    assert.equal((await readJson(file)).version, 1);
  });
});

test('writeCache retains only the most recently added keys', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'cache.json');

    await writeCache(file, { seen: new Set(['a', 'b', 'c', 'd', 'e']) }, 3);

    assert.deepEqual((await readJson(file)).seen, ['c', 'd', 'e']);
  });
});

test('writeCache with a limit of zero stores no keys', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'cache.json');

    await writeCache(file, { seen: new Set(['a', 'b']) }, 0);

    assert.deepEqual((await readJson(file)).seen, []);
  });
});

test('writeCache atomically replaces an existing file and leaves no temporary files', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'cache.json');

    await writeCache(file, { seen: new Set(['old']) }, 10);
    await writeCache(file, { seen: new Set(['new']) }, 10);

    assert.deepEqual([...(await readCache(file)).seen], ['new']);
    assert.deepEqual(await fs.readdir(directory), ['cache.json']);
  });
});

test('readCache rejects invalid JSON', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'cache.json');

    await fs.writeFile(file, '{invalid json');

    await assert.rejects(readCache(file), {
      message: `Cache file "${file}" contains invalid JSON.`,
    });
  });
});

test('readCache rejects unsupported formats', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'cache.json');

    for (const value of [null, ['a'], {}, { version: 1, seen: [1] }]) {
      await fs.writeFile(file, JSON.stringify(value));

      await assert.rejects(readCache(file), {
        message: `Cache file "${file}" has an unsupported format.`,
      });
    }
  });
});

test('readCache reports a cache written by a newer version', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'cache.json');

    await fs.writeFile(file, JSON.stringify({ version: 2, seen: [] }));

    await assert.rejects(readCache(file), /created by a newer version of bsky-rss-bot/);
  });
});

test('readCache surfaces filesystem errors other than missing files', async () => {
  await withTempDir(async (directory) => {
    const target = path.join(directory, 'cache-directory');

    await fs.mkdir(target);

    await assert.rejects(readCache(target), {
      message: `Unable to read cache file "${target}".`,
    });
  });
});
