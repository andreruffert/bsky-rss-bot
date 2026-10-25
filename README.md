# bsky-rss-bot

> Post an RSS or Atom feed to [Bluesky](https://bsky.app).

- Posts only the **newest** entries; older backlog is never posted
- Link cards with title, description and thumbnail
- Crash-safe de-duplication, with conditional requests (ETag / Last-Modified)
- Custom feed adapters and post text

ESM only. Requires Node.js 22.12.0 or newer.

## Install

```sh
npm install bsky-rss-bot
```

## Usage

```js
import Bot from 'bsky-rss-bot';

const bot = new Bot({
  feedUrl: 'https://example.com/feed.xml',
  account: {
    identifier: process.env.BSKY_IDENTIFIER, // handle or email
    password: process.env.BSKY_APP_PASSWORD, // use an app password, not your main password
  },
});

const result = await bot.run();
console.log(result); // { discovered, posted, simulated, cached, skipped, failed }
```

Try it first with `bot.run({ dryRun: true })`: nothing is published and the cache is untouched.

## How a run works

1. The feed is fetched (sending `If-None-Match` / `If-Modified-Since` when known; a `304` ends the run).
2. Entries are ordered newest first: by `published` when every entry has a parseable date, otherwise in feed order.
3. Entries whose key (`id`, falling back to `link`) is not in the cache are *unseen*.
4. The newest `postLimit` unseen entries are posted, **oldest of those first**. On an empty cache `initialPostLimit` applies instead.
5. Remaining older unseen entries are marked as seen without posting, so a backlog never trickles out later.
6. The cache is written after every successful post. A post that fails is not cached and is retried on the next run while it is still among the newest entries.

Use `populateCache: true` to mark everything currently in the feed as seen without posting (handy before the first real run).

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `feedUrl` | required | RSS 2.0, RSS 1.0 or Atom feed URL |
| `account` | required | `{ identifier, password }` |
| `service` | `https://bsky.social` | PDS / service URL |
| `postText` | title + link | Template string (`{title}`, `{link}`, `{description}`) or `(item) => string` |
| `getEntries` | built-in | `(parsedXml) => FeedItem[]` for non-standard feeds |
| `maxPostLength` | `300` | 1–300 graphemes; longer text is shortened without cutting URLs or hashtags |
| `langs` | `['en']` | Post languages |
| `embedCards` | `true` | Attach a link card (title, description, thumbnail) |
| `requestTimeout` | `15000` | Milliseconds, for feed, metadata and image requests |
| `logger` | `console` | Anything with `info`, `warn` and `error` |

### `run()` options

| Option | Default | Description |
| --- | --- | --- |
| `cacheFile` | `.bsky-rss-bot/cache.json` | Where seen entries and feed validators are stored |
| `cacheLimit` | `200` | Keys to remember (never fewer than the number of entries in the feed) |
| `initialPostLimit` | `5` | Entries to post when the cache is empty |
| `postLimit` | `5` | Entries to post per run afterwards |
| `dryRun` | `false` | Log what would be posted; no login, no posting, no cache writes |
| `populateCache` | `false` | Mark all current entries as seen, post nothing |

## Custom feeds

A `FeedItem` needs a `title` and an absolute `link`; `description`, `published` and `id` are optional.

```js
const bot = new Bot({
  feedUrl: 'https://example.com/feed.json.xml',
  account,
  getEntries: (feed) =>
    feed.catalog.product.map((p) => ({
      title: p.name,
      link: p.url,
      id: p.sku,
      description: p.summary,
    })),
  postText: (item) => `${item.title}\n\n${item.description}`,
});
```

Entries without a valid `http(s)` link are skipped with a warning; they never fail the run.

## Scheduling (GitHub Actions)

The cache file must survive between runs. This workflow keeps it in the Actions cache:

```yaml
name: Post feed
on:
  schedule: [{ cron: '*/30 * * * *' }]
  workflow_dispatch:

jobs:
  post:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 26
          cache: npm
      - uses: actions/cache@v7
        with:
          path: .bsky-rss-bot
          key: bsky-rss-bot-${{ github.run_id }}
          restore-keys: bsky-rss-bot-
      - run: npm ci
      - run: node bot.js
        env:
          BSKY_IDENTIFIER: ${{ secrets.BSKY_IDENTIFIER }}
          BSKY_APP_PASSWORD: ${{ secrets.BSKY_APP_PASSWORD }}
```

On first deployment, run once with `populateCache: true` (or a small `initialPostLimit`) so you decide what gets posted first.

