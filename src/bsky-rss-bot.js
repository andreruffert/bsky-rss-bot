/**
 * @import {BotConfig, FeedItem, RunOptions, RunResult} from './types.js'
 */

import path from 'node:path';
import { AtpAgent } from '@atproto/api';
import { readCache, writeCache } from './cache.js';
import { createPostRecord } from './post.js';
import { assertInteger, getFeed, stripHtml, truncateText, validateHttpUrl } from './utils.js';

const DEFAULT_SERVICE = 'https://bsky.social';

const DEFAULT_RUN_OPTIONS = {
  cacheFile: '.bsky-rss-bot/cache.json',
  cacheLimit: 200,
  initialPostLimit: 5,
  postLimit: 5,
  dryRun: false,
  populateCache: false,
};

/**
 * RSS/Atom publishing bot for Bluesky.
 *
 * Each run posts at most `postLimit` of the newest unseen entries (oldest of
 * those first). Older unseen entries are marked as seen and never posted.
 */
export default class Bot {
  /** @type {AtpAgent} */
  #agent;

  /** @type {import('./types.js').Logger} */
  #logger;

  #config;
  #loggedIn = false;
  #running = false;

  /**
   * @param {BotConfig} config
   */
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('Bot configuration is required.');
    }

    const { identifier, password } = config.account ?? {};

    if (!isFilled(identifier) || !isFilled(password)) {
      throw new TypeError('account.identifier and account.password are required.');
    }

    const feedUrl = validateHttpUrl(config.feedUrl, 'feedUrl').href;
    const service = validateHttpUrl(config.service ?? DEFAULT_SERVICE, 'service').href;

    if (config.getEntries !== undefined && typeof config.getEntries !== 'function') {
      throw new TypeError('getEntries must be a function.');
    }

    if (
      config.postText !== undefined &&
      typeof config.postText !== 'string' &&
      typeof config.postText !== 'function'
    ) {
      throw new TypeError('postText must be a string or a function.');
    }

    const maxPostLength = config.maxPostLength ?? 300;
    const requestTimeout = config.requestTimeout ?? 15000;
    const langs = config.langs ?? ['en'];

    assertInteger(maxPostLength, 'maxPostLength', 1, 300);
    assertInteger(requestTimeout, 'requestTimeout', 1);

    if (!Array.isArray(langs) || !langs.every((lang) => typeof lang === 'string')) {
      throw new TypeError('langs must be an array of strings.');
    }

    this.#config = {
      account: { identifier, password },
      feedUrl,
      getEntries: config.getEntries ?? defaultGetEntries,
      postText: config.postText,
      maxPostLength,
      langs,
      embedCards: config.embedCards ?? true,
      requestTimeout,
    };

    this.#logger = config.logger ?? console;
    this.#agent = new AtpAgent({ service });
  }

  /**
   * Process the feed and publish the newest unseen entries.
   *
   * @param {RunOptions} [options]
   * @returns {Promise<RunResult>}
   */
  async run(options = {}) {
    if (this.#running) {
      throw new Error('A run is already in progress on this Bot instance.');
    }

    this.#running = true;

    try {
      return await this.#run(resolveRunOptions(options));
    } finally {
      this.#running = false;
    }
  }

  async #run(settings) {
    const logger = this.#logger;
    const cacheFile = path.resolve(settings.cacheFile);
    const cache = await readCache(cacheFile);

    /** @type {RunResult} */
    const result = { discovered: 0, posted: 0, simulated: 0, cached: 0, skipped: 0, failed: 0 };

    logger.info('Fetching feed…');

    const response = await getFeed(this.#config.feedUrl, {
      timeout: this.#config.requestTimeout,
      ...(settings.dryRun ? {} : { etag: cache.etag, lastModified: cache.lastModified }),
    });

    if (response.notModified) {
      logger.info('Feed not modified.');
      return result;
    }

    const entries = this.#readEntries(response.feed);
    const unseen = entries.filter((item) => !cache.seen.has(item.key));
    const limit = cache.seen.size === 0 ? settings.initialPostLimit : settings.postLimit;

    // Entries beyond the limit are marked as seen so the backlog is never posted later.
    const toPost = settings.populateCache ? [] : unseen.slice(0, limit);
    const toMark = settings.populateCache ? unseen : unseen.slice(limit);

    result.discovered = unseen.length;

    if (settings.populateCache) result.cached = toMark.length;
    else result.skipped = toMark.length;

    logger.info(
      unseen.length === 0
        ? 'No new entries.'
        : `Discovered ${unseen.length}; posting ${toPost.length}, marking ${toMark.length} as seen.`,
    );

    const save = () => writeCache(cacheFile, cache, Math.max(settings.cacheLimit, entries.length));

    // Refresh the recency of entries still in the feed so that trimming only
    // ever evicts keys that have dropped out of it.
    for (const item of entries.toReversed()) {
      if (cache.seen.delete(item.key)) cache.seen.add(item.key);
    }

    if (toPost.length > 0 && !settings.dryRun) {
      await this.#login();
    }

    if (toMark.length > 0 && !settings.dryRun) {
      for (const item of toMark.toReversed()) cache.seen.add(item.key);
      await save();
    }

    // Publish oldest first so the profile timeline reads in chronological order.
    for (const item of toPost.toReversed()) {
      try {
        const record = await createPostRecord({
          text: await this.#resolvePostText(item),
          link: item.link,
          agent: this.#agent,
          logger,
          maxLength: this.#config.maxPostLength,
          langs: this.#config.langs,
          embedCards: this.#config.embedCards && !settings.dryRun,
          requestTimeout: this.#config.requestTimeout,
          detectFacets: !settings.dryRun,
        });

        if (settings.dryRun) {
          logger.info('--- DRY RUN ---');
          logger.info(record.text);
          logger.info('---------------');
          result.simulated++;
          continue;
        }

        await this.#agent.post(record);
      } catch (error) {
        result.failed++;
        logger.error(
          `Failed to process "${item.title}":`,
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        continue;
      }

      result.posted++;
      logger.info(`Posted: ${item.title}`);

      // Persist immediately so a crash can never cause a repost. A failure here
      // aborts the run rather than risking further duplicates.
      cache.seen.add(item.key);
      await save();
    }

    // Remember feed validators only when every entry was handled, so a failed
    // entry is not hidden behind a 304 on the next run.
    if (
      !settings.dryRun &&
      result.failed === 0 &&
      (cache.etag !== response.etag || cache.lastModified !== response.lastModified)
    ) {
      cache.etag = response.etag;
      cache.lastModified = response.lastModified;
      await save();
    }

    logger.info(
      `Run complete: posted=${result.posted}, simulated=${result.simulated}, cached=${result.cached}, skipped=${result.skipped}, failed=${result.failed}.`,
    );

    return result;
  }

  async #login() {
    if (this.#loggedIn) return;

    await this.#agent.login(this.#config.account);
    this.#loggedIn = true;
  }

  /**
   * Read, validate, de-duplicate and order (newest first) the feed entries.
   * Invalid entries are skipped with a warning instead of failing the run.
   *
   * @returns {Array<FeedItem & {key: string}>}
   */
  #readEntries(feed) {
    const entries = this.#config.getEntries(feed);

    if (!Array.isArray(entries)) {
      throw new TypeError('getEntries must return an array.');
    }

    const byKey = new Map();

    for (const entry of entries) {
      try {
        const item = normalizeEntry(entry);

        if (!byKey.has(item.key)) byKey.set(item.key, item);
      } catch (error) {
        this.#logger.warn(`Skipping invalid feed entry: ${error.message}`);
      }
    }

    return newestFirst([...byKey.values()]);
  }

  /**
   * @param {FeedItem} item
   * @returns {Promise<string>}
   */
  async #resolvePostText(item) {
    const { postText, maxPostLength } = this.#config;

    const text =
      typeof postText === 'function'
        ? await postText(item)
        : typeof postText === 'string'
          ? postText.replace(/\{(title|link|description)\}/g, (_, field) => item[field] ?? '')
          : defaultPostText(item, maxPostLength);

    if (typeof text !== 'string') {
      throw new TypeError('postText must resolve to a string.');
    }

    return text;
  }
}

/**
 * Merge run options with defaults and validate them.
 *
 * @param {RunOptions} options
 */
function resolveRunOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('run() requires an options object.');
  }

  const provided = Object.entries(options).filter(([, value]) => value !== undefined);
  const settings = { ...DEFAULT_RUN_OPTIONS, ...Object.fromEntries(provided) };

  if (typeof settings.cacheFile !== 'string' || !settings.cacheFile.trim()) {
    throw new TypeError('run() requires cacheFile.');
  }

  assertInteger(settings.cacheLimit, 'cacheLimit', 1);
  assertInteger(settings.initialPostLimit, 'initialPostLimit', 0);
  assertInteger(settings.postLimit, 'postLimit', 0);

  if (typeof settings.dryRun !== 'boolean' || typeof settings.populateCache !== 'boolean') {
    throw new TypeError('dryRun and populateCache must be booleans.');
  }

  if (settings.dryRun && settings.populateCache) {
    throw new TypeError('dryRun and populateCache cannot both be true.');
  }

  return settings;
}

function isFilled(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate one entry and add its de-duplication key.
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('entry must be an object.');
  }

  if (typeof entry.link !== 'string' || !entry.link.trim()) {
    throw new TypeError('entry must have a non-empty link.');
  }

  const link = entry.link.trim();

  validateHttpUrl(link, 'entry link');

  return { ...entry, link, title: String(entry.title || link), key: String(entry.id || link) };
}

/**
 * Order entries newest first by `published` when every entry has a parseable
 * date; otherwise trust the feed's own order (newest first by convention).
 */
function newestFirst(items) {
  const times = items.map((item) => Date.parse(item.published));

  if (times.some(Number.isNaN)) return items;

  return items
    .map((item, index) => ({ item, time: times[index] }))
    .sort((a, b) => b.time - a.time)
    .map(({ item }) => item);
}

/**
 * Title followed by the link, with the title shortened so the link always fits.
 */
function defaultPostText(item, maxLength) {
  const tail = `\n\n${item.link}`;
  const room = Math.max(1, maxLength - [...tail].length);

  return `${truncateText(item.title, room)}${tail}`;
}

/**
 * Read common RSS 2.0, RSS 1.0 and Atom entry shapes.
 *
 * @param {Record<string, any>} feed
 * @returns {FeedItem[]}
 */
function defaultGetEntries(feed) {
  const raw = feed?.feed?.entry ?? feed?.rss?.channel?.item ?? feed?.['rdf:RDF']?.item ?? [];

  return [raw]
    .flat()
    .map((entry) => {
      const link = getLink(entry);

      return {
        ...entry,
        title: readText(entry.title),
        link,
        description: stripHtml(readText(entry.description ?? entry.summary)),
        published: readText(entry.published ?? entry.updated ?? entry.pubDate ?? entry['dc:date']),
        id: readText(entry.id ?? entry.guid) || link,
      };
    })
    .filter((item) => item.link);
}

/**
 * Find an entry's URL: RSS <link> text, the Atom "alternate" link, then id/guid.
 */
function getLink(entry) {
  const links = [entry.link].flat();

  const href =
    links.find((link) => typeof link === 'string' && link) ??
    links.find((link) => link?.['@_href'] && (!link['@_rel'] || link['@_rel'] === 'alternate'))?.[
      '@_href'
    ];

  return String(href || readText(entry.id) || readText(entry.guid)).trim();
}

/**
 * Convert an XML parser value (string, or object with #text) into a string.
 */
function readText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return readText(value[0]);
  if (value && typeof value === 'object') return readText(value['#text']);

  return '';
}
