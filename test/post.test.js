import assert from 'node:assert/strict';
import test from 'node:test';

import { createPostRecord } from '../src/post.js';

// A valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const logger = () => ({ info() {}, warn() {}, error() {} });

function createAgent() {
  const uploads = [];

  return {
    uploads,
    uploadBlob: async (data, options) => {
      uploads.push({ data, options });
      return { data: { blob: { ref: 'test-blob' } } };
    },
  };
}

const base = { agent: createAgent(), logger: logger(), detectFacets: false, embedCards: false };

test('creates a valid Bluesky post record', async () => {
  const record = await createPostRecord({ ...base, text: 'Hello, Bluesky!' });

  assert.equal(record.$type, 'app.bsky.feed.post');
  assert.equal(record.text, 'Hello, Bluesky!');
  assert.equal(record.facets, undefined);
  assert.deepEqual(record.langs, ['en']);
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
  assert.equal('embed' in record, false);
});

test('copies custom languages', async () => {
  const langs = ['en', 'de'];
  const record = await createPostRecord({ ...base, text: 'Hallo!', langs });

  langs.push('fr');
  assert.deepEqual(record.langs, ['en', 'de']);
});

test('truncates text to the configured maximum length', async () => {
  const record = await createPostRecord({ ...base, text: 'abcdefghij', maxLength: 5 });

  assert.equal(record.text, 'abcd…');
});

test('rejects non-string text and a missing agent', async () => {
  await assert.rejects(createPostRecord({ ...base, text: 123 }), {
    name: 'TypeError',
    message: 'Post text must be a string.',
  });

  await assert.rejects(createPostRecord({ ...base, text: 'Hi', agent: undefined }), {
    name: 'TypeError',
    message: 'An authenticated Bluesky agent is required.',
  });
});

test('does not embed a card when embedCards is false', async () => {
  const record = await createPostRecord({ ...base, text: 'Hi', link: 'https://example.com' });

  assert.equal('embed' in record, false);
});

test('embeds a card with title, description and a thumbnail resolved from a relative og:image', async (t) => {
  const requested = [];

  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  });

  const agent = createAgent();

  const record = await createPostRecord({
    ...base,
    agent,
    embedCards: true,
    text: 'Hi',
    link: 'https://example.com/articles/one',
    fetchMetadata: async () => ({
      title: 'A title',
      description: 'A description',
      'og:image': '/images/cover.png',
    }),
  });

  assert.deepEqual(requested, ['https://example.com/images/cover.png']);
  assert.equal(record.embed.$type, 'app.bsky.embed.external');
  assert.equal(record.embed.external.uri, 'https://example.com/articles/one');
  assert.equal(record.embed.external.title, 'A title');
  assert.equal(record.embed.external.description, 'A description');
  assert.deepEqual(record.embed.external.thumb, { ref: 'test-blob' });
  assert.equal(agent.uploads.length, 1);
});

test('keeps title and description when the thumbnail cannot be fetched or uploaded', async (t) => {
  const link = 'https://example.com/a';
  const fetchMetadata = async () => ({
    title: 'T',
    description: 'D',
    'og:image': 'https://example.com/i.png',
  });

  t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 404 }));

  let record = await createPostRecord({
    ...base,
    embedCards: true,
    text: 'Hi',
    link,
    fetchMetadata,
  });

  assert.equal(record.embed.external.title, 'T');
  assert.equal(record.embed.external.thumb, undefined);

  globalThis.fetch.mock.mockImplementation(
    async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  );

  const agent = { uploadBlob: async () => Promise.reject(new Error('upload failed')) };

  record = await createPostRecord({
    ...base,
    agent,
    embedCards: true,
    text: 'Hi',
    link,
    fetchMetadata,
  });

  assert.equal(record.embed.external.title, 'T');
  assert.equal(record.embed.external.description, 'D');
  assert.equal(record.embed.external.thumb, undefined);
});

test('falls back to a bare link card when metadata cannot be read', async () => {
  const warnings = [];
  const link = 'https://example.com/a';

  const record = await createPostRecord({
    ...base,
    embedCards: true,
    text: 'Hi',
    link,
    logger: { ...logger(), warn: (...args) => warnings.push(args) },
    fetchMetadata: async () => {
      throw new Error('boom');
    },
  });

  assert.deepEqual(record.embed.external, { uri: link, title: link, description: '' });
  assert.equal(warnings.length, 1);
});
