/**
 * @typedef {Object} AccountConfig
 * @property {string} identifier Handle or email.
 * @property {string} password An app password is recommended.
 */

/**
 * Normalized feed entry. Custom `getEntries` adapters must provide `title`
 * and `link`; everything else is optional and extra fields are preserved.
 *
 * @typedef {Object} FeedItem
 * @property {string} title
 * @property {string} link
 * @property {string} [description] Plain text (HTML is stripped by the default adapter).
 * @property {string} [published] Used to order entries newest-first when every entry has a parseable date.
 * @property {string} [id] Stable identifier used for de-duplication; defaults to `link`.
 */

/**
 * Minimal logger interface.
 *
 * @typedef {Object} Logger
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} warn
 * @property {(...args: any[]) => void} error
 */

/**
 * Bluesky post record.
 *
 * @typedef {Object} PostRecord
 * @property {'app.bsky.feed.post'} $type
 * @property {string} text
 * @property {import('@atproto/api').AppBskyRichtextFacet.Main[]} [facets]
 * @property {Object} [embed]
 * @property {string} createdAt
 * @property {string[]} langs
 */

/**
 * Constructor configuration.
 *
 * @typedef {Object} BotConfig
 * @property {string} feedUrl
 * @property {AccountConfig} account
 * @property {string} [service='https://bsky.social']
 * @property {Logger} [logger=console]
 * @property {(feed: Record<string, any>) => FeedItem[]} [getEntries] Custom feed adapter; receives the parsed XML.
 * @property {string | ((item: FeedItem) => string | Promise<string>)} [postText] Template or function. Strings may use `{title}`, `{link}` and `{description}`. Defaults to the title followed by the link.
 * @property {number} [maxPostLength=300]
 * @property {string[]} [langs=['en']]
 * @property {boolean} [embedCards=true]
 * @property {number} [requestTimeout=15000] Milliseconds.
 */

/**
 * Options for one run.
 *
 * @typedef {Object} RunOptions
 * @property {string} [cacheFile='.bsky-rss-bot/cache.json']
 * @property {number} [cacheLimit=200] Minimum number of entry keys to remember (at least the feed size is always kept).
 * @property {number} [initialPostLimit=5] Newest entries to post when the cache is empty.
 * @property {number} [postLimit=5] Newest entries to post on later runs.
 * @property {boolean} [dryRun=false] Log what would be posted; no network writes, no cache changes.
 * @property {boolean} [populateCache=false] Mark every current entry as seen without posting.
 */

/**
 * Result of one run.
 *
 * `discovered` is the number of unseen entries in the feed.
 * `posted` counts successful Bluesky publications only.
 * `simulated` counts posts prepared by a dry run.
 * `cached` counts entries marked as seen by populate-cache mode.
 * `skipped` counts unseen entries beyond the post limit; they are marked as seen and never posted.
 * `failed` counts entries that could not be posted; they are retried on the next run.
 *
 * @typedef {Object} RunResult
 * @property {number} discovered
 * @property {number} posted
 * @property {number} simulated
 * @property {number} cached
 * @property {number} skipped
 * @property {number} failed
 */

/**
 * State persisted between runs.
 *
 * @typedef {Object} CacheState
 * @property {Set<string>} seen Entry keys, oldest first.
 * @property {string} [etag]
 * @property {string} [lastModified]
 */

export {};
