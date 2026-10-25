import { RichText } from '@atproto/api';
import sharp from 'sharp';
import { getUrlMetadata, truncateText, validateHttpUrl } from './utils.js';

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 1_000_000; // Bluesky's blob limit for link-card thumbnails.
const MAX_IMAGE_PIXELS = 40_000_000;

/**
 * Create a Bluesky post record.
 *
 * @param {Object} options
 * @param {string} options.text
 * @param {import('@atproto/api').AtpAgent} options.agent
 * @param {import('./types.js').Logger} options.logger
 * @param {string} [options.link]
 * @param {number} [options.maxLength=300]
 * @param {string[]} [options.langs=['en']]
 * @param {boolean} [options.embedCards=true]
 * @param {number} [options.requestTimeout=15000]
 * @param {boolean} [options.detectFacets=true]
 * @param {typeof getUrlMetadata} [options.fetchMetadata] Replaceable for tests.
 * @returns {Promise<import('./types.js').PostRecord>}
 */
export async function createPostRecord({
  text,
  link,
  agent,
  logger,
  maxLength = 300,
  langs = ['en'],
  embedCards = true,
  requestTimeout = 15000,
  detectFacets = true,
  fetchMetadata = getUrlMetadata,
}) {
  if (typeof text !== 'string') {
    throw new TypeError('Post text must be a string.');
  }

  if (!agent) {
    throw new TypeError('An authenticated Bluesky agent is required.');
  }

  const richText = new RichText({ text: truncateText(text, maxLength) });

  if (detectFacets) {
    await richText.detectFacets(agent);
  }

  const embed =
    embedCards && link
      ? await getEmbedCard({ url: link, agent, logger, requestTimeout, fetchMetadata })
      : undefined;

  return {
    $type: 'app.bsky.feed.post',
    text: richText.text,
    facets: richText.facets,
    ...(embed ? { embed } : {}),
    createdAt: new Date().toISOString(),
    langs: [...langs],
  };
}

/**
 * Build an external link card. The card always carries the URL; page metadata
 * and the thumbnail are best-effort, and a thumbnail failure never discards
 * the title or description.
 */
async function getEmbedCard({ url, agent, logger, requestTimeout, fetchMetadata }) {
  const external = { uri: url, title: url, description: '' };

  try {
    const metadata = await fetchMetadata(url, { timeout: requestTimeout });

    external.title = String(metadata?.title || url).slice(0, 1000);
    external.description = String(metadata?.description || '').slice(0, 3000);

    const imageUrl = [metadata?.['og:image'], metadata?.image]
      .flat()
      .find((value) => typeof value === 'string' && value);

    if (imageUrl) {
      // og:image is frequently relative to the page.
      const thumb = await uploadThumbnail(new URL(imageUrl, url).href, { agent, requestTimeout });

      if (thumb) external.thumb = thumb;
    }
  } catch (error) {
    logger.warn(
      'Unable to build the full link card:',
      error instanceof Error ? error.message : error,
    );
  }

  return { $type: 'app.bsky.embed.external', external };
}

/**
 * Download an image, shrink it to fit Bluesky's limits and upload it.
 *
 * @returns {Promise<import('@atproto/api').BlobRef | undefined>}
 */
async function uploadThumbnail(imageUrl, { agent, requestTimeout }) {
  const image = await fetchImage(imageUrl, requestTimeout);
  const thumbnail = image && (await prepareThumbnail(image));

  if (!thumbnail) return undefined;

  const { data } = await agent.uploadBlob(thumbnail.data, { encoding: thumbnail.type });

  return data.blob;
}

/**
 * Download an image with a timeout and a byte limit.
 *
 * @returns {Promise<{data: Buffer, type: string} | null>}
 */
async function fetchImage(imageUrl, timeout) {
  validateHttpUrl(imageUrl, 'Thumbnail URL');

  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(timeout) });
  const contentLength = Number(response.headers.get('content-length'));

  if (!response.ok || !response.body || contentLength > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    return null;
  }

  const chunks = [];
  let total = 0;

  // Leaving the loop early cancels the underlying stream.
  for await (const chunk of response.body) {
    total += chunk.byteLength;

    if (total > MAX_DOWNLOAD_BYTES) return null;

    chunks.push(chunk);
  }

  return {
    data: Buffer.concat(chunks, total),
    type: response.headers.get('content-type')?.split(';')[0].trim() ?? '',
  };
}

/**
 * Resize the image to fit a link card and re-encode it as JPEG, lowering the
 * quality until it satisfies Bluesky's blob limit.
 *
 * @returns {Promise<{data: Buffer, type: string} | null>}
 */
async function prepareThumbnail({ data }) {
  const pipeline = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS }).resize({
    width: 1200,
    height: 630,
    fit: 'inside',
    withoutEnlargement: true,
  });

  for (const quality of [80, 60, 40]) {
    const jpeg = await pipeline.clone().jpeg({ quality }).toBuffer();

    if (jpeg.length <= MAX_THUMBNAIL_BYTES) return { data: jpeg, type: 'image/jpeg' };
  }

  return null;
}
