import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { AtpAgent } from '@atproto/api';

import Bot from '../src/bsky-rss-bot.js';
import { readCache, writeCache } from '../src/cache.js';

const validConfig = {
  account: { identifier: 'bot.example.com', password: 'test-password' },
  feedUrl: 'https://example.com/feed.xml',
};

const silent = { info() {}, warn() {}, error() {} };

/** Build an RSS 2.0 feed. Items are listed in the order given. */
function rss(items) {
  const body = items
    .map(
      ({ title, link, date }) =>
        `<item>${title ? `<title>${title}</title>` : ''}${link ? `<link>${link}</link>` : ''}${
          date ? `<pubDate>${date}</pubDate>` : ''
        }</item>`,
    )
    .join('');

  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${body}</channel></rss>`;
}

const item = (n, extra = {}) => ({
  title: `Post ${n}`,
  link: `https://example.com/${n}`,
  ...extra,
});

let directory;
let cacheFile;
let posted;
let postImpl;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bsky-rss-bot-test-'));
  cacheFile = path.join(directory, 'cache.json');
  posted = [];
  postImpl = async () => {};

  mock.method(AtpAgent.prototype, 'login', async () => ({}));
  mock.method(AtpAgent.prototype, 'post', async (record) => {
    await postImpl(record);
    posted.push(record.text);
  });
});

afterEach(async () => {
  mock.restoreAll();
  await fs.rm(directory, { recursive: true, force: true });
});

function serveFeed(xml, { status = 200, headers = {} } = {}) {
  return mock.method(
    globalThis,
    'fetch',
    async () => new Response(status === 304 ? null : xml, { status, headers }),
  );
}

function createBot(config = {}) {
  return new Bot({ ...validConfig, logger: silent, embedCards: false, ...config });
}

const run = (bot, options = {}) => bot.run({ cacheFile, ...options });
const seenKeys = async () => [...(await readCache(cacheFile)).seen];

describe('Bot constructor', () => {
  it('accepts valid configuration', () => {
    assert.doesNotThrow(() => new Bot(validConfig));
  });

  it('rejects missing configuration', () => {
    for (const config of [undefined, null]) {
      assert.throws(() => new Bot(config), {
        name: 'TypeError',
        message: 'Bot configuration is required.',
      });
    }
  });

  it('rejects missing or blank account credentials', () => {
    for (const account of [
      undefined,
      {},
      { identifier: '', password: 'secret' },
      { identifier: 'bot.example.com', password: '' },
      { identifier: '   ', password: 'secret' },
      { identifier: 'bot.example.com', password: '   ' },
    ]) {
      assert.throws(() => new Bot({ ...validConfig, account }), {
        name: 'TypeError',
        message: 'account.identifier and account.password are required.',
      });
    }
  });

  it('rejects invalid feed and service URLs', () => {
    for (const url of ['not-a-url', 'ftp://example.com/x', 'https://user:password@example.com/x']) {
      assert.throws(() => new Bot({ ...validConfig, feedUrl: url }), TypeError);
      assert.throws(() => new Bot({ ...validConfig, service: url }), TypeError);
    }
  });

  it('validates getEntries and postText', () => {
    assert.throws(() => new Bot({ ...validConfig, getEntries: [] }), {
      message: 'getEntries must be a function.',
    });

    for (const postText of [123, true, {}, []]) {
      assert.throws(() => new Bot({ ...validConfig, postText }), {
        message: 'postText must be a string or a function.',
      });
    }

    assert.doesNotThrow(() => new Bot({ ...validConfig, postText: 'Hello!' }));
    assert.doesNotThrow(() => new Bot({ ...validConfig, postText: () => 'Hello!' }));
  });

  it('validates maxPostLength', () => {
    for (const maxPostLength of [0, -1, 1.5, 301, Number.NaN]) {
      assert.throws(() => new Bot({ ...validConfig, maxPostLength }), {
        name: 'RangeError',
        message: 'maxPostLength must be an integer from 1 to 300.',
      });
    }

    for (const maxPostLength of [1, 100, 300]) {
      assert.doesNotThrow(() => new Bot({ ...validConfig, maxPostLength }));
    }
  });

  it('validates langs', () => {
    for (const langs of ['en', [1], [null], {}]) {
      assert.throws(() => new Bot({ ...validConfig, langs }), {
        message: 'langs must be an array of strings.',
      });
    }

    assert.doesNotThrow(() => new Bot({ ...validConfig, langs: ['en', 'de'] }));
  });

  it('validates requestTimeout', () => {
    for (const requestTimeout of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new Bot({ ...validConfig, requestTimeout }), {
        name: 'RangeError',
        message: 'requestTimeout must be a positive integer.',
      });
    }

    assert.doesNotThrow(() => new Bot({ ...validConfig, requestTimeout: 5000 }));
  });
});

describe('Bot.run() options', () => {
  it('rejects invalid option values before touching the network', async () => {
    const fetchMock = serveFeed(rss([]));
    const bot = createBot();

    for (const options of [null, 'invalid']) {
      await assert.rejects(bot.run(options), { message: 'run() requires an options object.' });
    }

    await assert.rejects(bot.run({ cacheFile: '  ' }), { message: 'run() requires cacheFile.' });

    for (const key of ['cacheLimit', 'initialPostLimit', 'postLimit']) {
      for (const value of [-1, 1.5, Number.NaN]) {
        await assert.rejects(run(bot, { [key]: value }), { name: 'RangeError' });
      }
    }

    await assert.rejects(run(bot, { cacheLimit: 0 }), {
      message: 'cacheLimit must be a positive integer.',
    });
    await assert.rejects(run(bot, { dryRun: 'true' }), {
      message: 'dryRun and populateCache must be booleans.',
    });
    await assert.rejects(run(bot, { dryRun: true, populateCache: true }), {
      message: 'dryRun and populateCache cannot both be true.',
    });

    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('works without arguments and treats undefined options as defaults', async () => {
    serveFeed(rss([item(1)]));

    const result = await createBot().run({ dryRun: true, postLimit: undefined });

    assert.equal(result.simulated, 1);
  });
});

describe('Bot.run() posting', () => {
  it('posts only the newest entries on the first run and marks the rest as seen', async () => {
    serveFeed(rss([item(5), item(4), item(3), item(2), item(1)]));

    const result = await run(createBot(), { initialPostLimit: 2 });

    assert.deepEqual(result, {
      discovered: 5,
      posted: 2,
      simulated: 0,
      cached: 0,
      skipped: 3,
      failed: 0,
    });
    assert.equal(posted.length, 2);
    assert.ok(posted.every((text) => text.includes('Post 5') || text.includes('Post 4')));
    assert.equal((await seenKeys()).length, 5);
  });

  it('publishes the selected entries oldest first', async () => {
    serveFeed(rss([item(3), item(2), item(1)]));

    await run(createBot());

    assert.deepEqual(
      posted.map((text) => text.split('\n')[0]),
      ['Post 1', 'Post 2', 'Post 3'],
    );
  });

  it('never posts the backlog on later runs', async () => {
    serveFeed(rss([item(8), item(7), item(6), item(5), item(4), item(3), item(2), item(1)]));

    await run(createBot(), { initialPostLimit: 2 });
    posted.length = 0;

    const result = await run(createBot(), { initialPostLimit: 2 });

    assert.equal(result.discovered, 0);
    assert.equal(result.posted, 0);
    assert.deepEqual(posted, []);
  });

  it('uses postLimit once the cache has entries and skips older unseen entries', async () => {
    await writeCache(cacheFile, { seen: new Set(['https://example.com/1']) }, 10);
    serveFeed(rss([item(5), item(4), item(3), item(2), item(1)]));

    const result = await run(createBot(), { postLimit: 1 });

    assert.equal(result.posted, 1);
    assert.equal(result.skipped, 3);
    assert.match(posted[0], /Post 5/);
  });

  it('returns zero counts when there is nothing new', async () => {
    await writeCache(cacheFile, { seen: new Set(['https://example.com/1']) }, 10);
    serveFeed(rss([item(1)]));

    assert.deepEqual(await run(createBot()), {
      discovered: 0,
      posted: 0,
      simulated: 0,
      cached: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('orders by published date when every entry has one, regardless of feed order', async () => {
    serveFeed(
      rss([
        item(1, { date: 'Mon, 01 Jan 2024 10:00:00 GMT' }),
        item(3, { date: 'Wed, 03 Jan 2024 10:00:00 GMT' }),
        item(2, { date: 'Tue, 02 Jan 2024 10:00:00 GMT' }),
      ]),
    );

    await run(createBot(), { initialPostLimit: 2 });

    assert.deepEqual(
      posted.map((text) => text.split('\n')[0]),
      ['Post 2', 'Post 3'],
    );
  });

  it('uses the title and link by default and supports string and function templates', async () => {
    serveFeed(rss([item(1)]));

    await run(createBot());
    assert.equal(posted[0], 'Post 1\n\nhttps://example.com/1');

    posted.length = 0;
    await fs.rm(cacheFile);

    await run(createBot({ postText: 'New: {title} {link}' }));
    assert.equal(posted[0], 'New: Post 1 https://example.com/1');

    posted.length = 0;
    await fs.rm(cacheFile);

    await run(createBot({ postText: async (entry) => `Custom ${entry.title}` }));
    assert.equal(posted[0], 'Custom Post 1');
  });

  it('skips invalid entries and de-duplicates by key instead of failing the run', async () => {
    const warnings = [];
    serveFeed(rss([item(1), { title: 'No link' }, item(1), item(2)]));

    const result = await run(createBot({ logger: { ...silent, warn: (m) => warnings.push(m) } }));

    assert.equal(result.posted, 2);
    assert.equal(warnings.length, 0); // entries without a link are dropped by the default adapter
  });

  it('warns about invalid entries produced by a custom adapter', async () => {
    const warnings = [];
    serveFeed(rss([]));

    const bot = createBot({
      logger: { ...silent, warn: (m) => warnings.push(m) },
      getEntries: () => [
        { title: 'bad', link: 'not a url' },
        null,
        { title: 'ok', link: 'https://example.com/ok' },
      ],
    });

    const result = await run(bot);

    assert.equal(result.posted, 1);
    assert.equal(warnings.length, 2);
  });
});

describe('Bot.run() failures and persistence', () => {
  it('does not cache entries that fail to publish and retries them next run', async () => {
    serveFeed(rss([item(2), item(1)]));
    postImpl = async (record) => {
      if (record.text.startsWith('Post 1')) throw new Error('rejected');
    };

    const result = await run(createBot());

    assert.equal(result.posted, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(await seenKeys(), ['https://example.com/2']);

    postImpl = async () => {};
    const retry = await run(createBot());

    assert.equal(retry.posted, 1);
    assert.match(posted.at(-1), /Post 1/);
  });

  it('writes the cache after every successful post, not only at the end', async () => {
    serveFeed(rss([item(2), item(1)]));

    let cachedBeforeSecondPost;
    postImpl = async (record) => {
      if (record.text.startsWith('Post 2')) cachedBeforeSecondPost = await seenKeys();
    };

    await run(createBot());

    assert.deepEqual(cachedBeforeSecondPost, ['https://example.com/1']);
  });

  it('releases the run lock after a failure and rejects concurrent runs', async () => {
    const bot = createBot();

    const failing = mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
    await assert.rejects(run(bot), /HTTP 500/);
    failing.mock.restore();

    serveFeed(rss([item(1)]));
    const first = run(bot);
    await assert.rejects(run(bot), {
      message: 'A run is already in progress on this Bot instance.',
    });
    await first;
  });

  it('logs in only once across runs', async () => {
    const feed = serveFeed(rss([item(1)]));
    const bot = createBot();

    await run(bot);
    feed.mock.restore();
    serveFeed(rss([item(2), item(1)]));
    await run(bot);

    assert.equal(AtpAgent.prototype.login.mock.callCount(), 1);
  });
});

describe('Bot.run() modes', () => {
  it('dry run simulates posts without logging in, posting or touching the cache', async () => {
    serveFeed(rss([item(2), item(1)]));

    const result = await run(createBot(), { dryRun: true });

    assert.equal(result.simulated, 2);
    assert.equal(result.posted, 0);
    assert.deepEqual(posted, []);
    assert.equal(AtpAgent.prototype.login.mock.callCount(), 0);
    await assert.rejects(fs.access(cacheFile));
  });

  it('populateCache marks every entry as seen without posting', async () => {
    serveFeed(rss([item(3), item(2), item(1)]));

    const result = await run(createBot(), { populateCache: true });

    assert.equal(result.cached, 3);
    assert.equal(result.posted, 0);
    assert.deepEqual(posted, []);
    assert.equal((await seenKeys()).length, 3);
  });

  it('respects cacheLimit but never forgets entries that are still in the feed', async () => {
    serveFeed(rss([item(4), item(3), item(2), item(1)]));

    await run(createBot(), { populateCache: true, cacheLimit: 2 });

    assert.equal((await seenKeys()).length, 4);

    serveFeed(rss([item(5), item(1)]));
    await run(createBot(), { populateCache: true, cacheLimit: 2 });

    assert.deepEqual(await seenKeys(), ['https://example.com/1', 'https://example.com/5']);
  });
});

describe('Bot.run() conditional requests', () => {
  it('stores validators, sends them next time and treats 304 as no new entries', async () => {
    const fetchMock = serveFeed(rss([item(1)]), {
      headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    });

    await run(createBot());

    const cache = await readCache(cacheFile);
    assert.equal(cache.etag, '"v1"');
    assert.equal(cache.lastModified, 'Mon, 01 Jan 2024 00:00:00 GMT');

    fetchMock.mock.restore();
    const second = serveFeed(null, { status: 304 });

    const result = await run(createBot());

    const headers = second.mock.calls[0].arguments[1].headers;
    assert.equal(headers['if-none-match'], '"v1"');
    assert.equal(headers['if-modified-since'], 'Mon, 01 Jan 2024 00:00:00 GMT');
    assert.equal(result.discovered, 0);
    assert.equal(AtpAgent.prototype.login.mock.callCount(), 1);
  });

  it('keeps old validators when an entry failed so it is retried', async () => {
    serveFeed(rss([item(1)]), { headers: { etag: '"v2"' } });
    postImpl = async () => {
      throw new Error('rejected');
    };

    const result = await run(createBot());

    assert.equal(result.failed, 1);
    assert.equal((await readCache(cacheFile)).etag, undefined);
  });
});
