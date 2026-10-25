import assert from 'node:assert/strict';
import test from 'node:test';

import { assertInteger, stripHtml, truncateText, validateHttpUrl } from '../src/utils.js';

test('assertInteger accepts integers in range and describes violations', () => {
  assert.doesNotThrow(() => assertInteger(5, 'n', 1, 10));
  assert.doesNotThrow(() => assertInteger(0, 'n', 0));

  assert.throws(() => assertInteger(0, 'n', 1, 10), {
    name: 'RangeError',
    message: 'n must be an integer from 1 to 10.',
  });
  assert.throws(() => assertInteger(-1, 'n', 0), { message: 'n must be a non-negative integer.' });
  assert.throws(() => assertInteger(1.5, 'n', 1), { message: 'n must be a positive integer.' });
  assert.throws(() => assertInteger(Number.NaN, 'n', 3), {
    message: 'n must be an integer of at least 3.',
  });
});

test('validateHttpUrl accepts HTTP, HTTPS and URL instances', () => {
  assert.equal(validateHttpUrl('https://example.com/path').href, 'https://example.com/path');
  assert.equal(validateHttpUrl('http://example.com').protocol, 'http:');

  const url = new URL('https://example.com');
  assert.equal(validateHttpUrl(url).href, url.href);
});

test('validateHttpUrl rejects malformed URLs, other protocols and credentials', () => {
  assert.throws(() => validateHttpUrl('not a URL'), {
    name: 'TypeError',
    message: 'URL must be a valid URL.',
  });
  assert.throws(() => validateHttpUrl('ftp://example.com'), {
    message: 'URL must use HTTP or HTTPS.',
  });
  assert.throws(() => validateHttpUrl('https://user:password@example.com'), {
    message: 'URL must not contain embedded credentials.',
  });
  assert.throws(() => validateHttpUrl('invalid', 'feedUrl'), {
    message: 'feedUrl must be a valid URL.',
  });
});

test('stripHtml removes tags, keeps paragraph breaks and decodes entities', () => {
  assert.equal(
    stripHtml('<p>Hello &amp; welcome</p><p>Second&nbsp;line</p>'),
    'Hello & welcome\nSecond line',
  );
  assert.equal(stripHtml('a<br/>b<script>alert(1)</script>c'), 'a\nbc');
  assert.equal(stripHtml('&#8217;&#x1F600; &unknown; &#0;'), '’😀 &unknown; &#0;');
  assert.equal(stripHtml('plain text'), 'plain text');
});

test('truncateText trims and leaves text within the limit unchanged', () => {
  assert.equal(truncateText('  Hello  ', 5), 'Hello');
  assert.equal(truncateText('   '), '');
});

test('truncateText truncates at the limit and appends an ellipsis', () => {
  assert.equal(truncateText('Hello world', 5), 'Hell…');
  assert.equal(truncateText('abcdefghij', 5), 'abcd…');
});

test('truncateText breaks at word boundaries before cutting a word when possible', () => {
  assert.equal(truncateText('one two three', 8), 'one two…');
});

test('truncateText never cuts a URL or hashtag in half', () => {
  assert.equal(truncateText('See https://example.com/long-path now', 15), 'See…');
  assert.equal(truncateText('Great news #somethinglong', 15), 'Great news…');
  assert.equal(truncateText('Short https://a.co', 18), 'Short https://a.co');
});

test('truncateText preserves complete grapheme clusters', () => {
  const result = truncateText('A👨‍👩‍👧‍👦BC', 3);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  assert.equal(result, 'A👨‍👩‍👧‍👦…');
  assert.equal([...segmenter.segment(result)].length, 3);
});

test('truncateText rejects invalid maximum lengths', () => {
  for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => truncateText('Hello', max), {
      name: 'RangeError',
      message: 'max must be a positive integer.',
    });
  }
});
