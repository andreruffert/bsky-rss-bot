import { XMLParser } from 'fast-xml-parser';
import urlMetadata from 'url-metadata';

const USER_AGENT = 'bsky-rss-bot (+https://www.npmjs.com/package/bsky-rss-bot)';

// parseTagValue is off so values such as "1.50" or "007" are not turned into numbers.
const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
  parseTagValue: false,
});

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Throw a RangeError unless value is an integer within [min, max].
 *
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} [max]
 */
export function assertInteger(value, name, min, max = Number.POSITIVE_INFINITY) {
  if (Number.isInteger(value) && value >= min && value <= max) return;

  let expected = `an integer from ${min} to ${max}`;

  if (max === Number.POSITIVE_INFINITY) {
    if (min === 0) expected = 'a non-negative integer';
    else if (min === 1) expected = 'a positive integer';
    else expected = `an integer of at least ${min}`;
  }

  throw new RangeError(`${name} must be ${expected}.`);
}

/**
 * Validate an HTTP(S) URL.
 *
 * @param {string | URL} value
 * @param {string} label
 * @returns {URL}
 */
export function validateHttpUrl(value, label = 'URL') {
  let url;

  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new TypeError(`${label} must be a valid URL.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`${label} must use HTTP or HTTPS.`);
  }

  if (url.username || url.password) {
    throw new TypeError(`${label} must not contain embedded credentials.`);
  }

  return url;
}

/**
 * Fetch and parse an RSS or Atom feed. Sends conditional request headers when
 * validators from a previous response are supplied.
 *
 * @param {string} feedUrl
 * @param {{timeout?: number, etag?: string, lastModified?: string}} [options]
 * @returns {Promise<{notModified: true} | {notModified?: false, feed: Record<string, any>, etag?: string, lastModified?: string}>}
 */
export async function getFeed(feedUrl, { timeout = 15000, etag, lastModified } = {}) {
  const headers = {
    accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
    'user-agent': USER_AGENT,
  };

  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const response = await fetch(validateHttpUrl(feedUrl, 'feedUrl'), {
    signal: AbortSignal.timeout(timeout),
    headers,
  });

  if (response.status === 304) {
    await response.body?.cancel();
    return { notModified: true };
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Feed request failed with HTTP ${response.status}.`);
  }

  const feed = XML_PARSER.parse(await response.text());

  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    throw new Error('The feed did not contain a valid XML document.');
  }

  return {
    feed,
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
}

/**
 * Fetch page metadata (title, description, og:image, ...). Throws on failure.
 *
 * @param {string} url
 * @param {{timeout?: number}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function getUrlMetadata(url, { timeout = 10000 } = {}) {
  let timer;

  try {
    return await Promise.race([
      urlMetadata(url, { timeout }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Metadata request timed out.')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reduce an HTML fragment to plain text: drops tags, keeps paragraph breaks
 * and decodes common entities.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] !== '#') return HTML_ENTITIES[entity.toLowerCase()] ?? match;

      const hex = entity[1].toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);

      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Truncate text to a maximum number of Unicode grapheme clusters, without
 * cutting URLs or hashtags in half. The result, including the ellipsis,
 * never exceeds max graphemes.
 *
 * @param {string} text
 * @param {number} [max=300]
 * @returns {string}
 */
export function truncateText(text, max = 300) {
  assertInteger(max, 'max', 1);

  const value = text.trim();
  const split = (input) => Array.from(SEGMENTER.segment(input), ({ segment }) => segment);

  if (split(value).length <= max) return value;

  const limit = max - 1;

  // Match URLs, hashtags, ordinary words, and whitespace.
  const tokens = value.match(/https?:\/\/\S+|#[\p{L}\p{M}\p{N}_]+|\S+|\s+/gu) ?? [];

  let result = '';
  let used = 0;

  for (const token of tokens) {
    const graphemes = split(token);

    if (used + graphemes.length <= limit) {
      result += token;
      used += graphemes.length;
      continue;
    }

    // URLs and hashtags are included in full or not at all; whitespace is dropped.
    const isProtected = /^https?:\/\//i.test(token) || /^#[\p{L}\p{M}\p{N}_]+$/u.test(token);

    if (!isProtected && !/^\s+$/u.test(token) && limit - used > 0) {
      result += graphemes.slice(0, limit - used).join('');
    }

    break;
  }

  return `${result.trimEnd()}…`;
}
