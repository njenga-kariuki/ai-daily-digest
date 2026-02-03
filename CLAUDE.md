# AI Daily Digest

Daily digest system that aggregates AI-focused content from Twitter bookmarks and email newsletters, summarizes with Claude, and delivers via email.

## Quick Start

```bash
# Install dependencies
npm install

# Set up Gmail OAuth (one-time)
npm run gmail-auth

# Run digest manually
npm run dev -- --run-now

# Run in daemon mode (scheduled)
npm run dev -- --daemon
```

## Required Environment Variables

```bash
# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Twitter/X API (Basic tier, $200/mo required for bookmarks)
TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...
```

## Configuration

Edit `src/config/sources.json`:

| Setting | Description |
|---------|-------------|
| `twitter.bookmarkFolders` | Bookmark folder names to pull from |
| `twitter.lookbackHours` | How far back to fetch (default: 24h) |
| `gmail.newsletterLabel` | Gmail label for AI newsletters |
| `output.recipientEmail` | Where to send the digest |
| `output.digestTime` | When to send (e.g., "07:00") |
| `output.timezone` | Timezone for scheduling |
| `processing.focusAreas` | AI topics to prioritize |

## Architecture

```
src/
├── index.ts              # Main entry + scheduler
├── config/
│   ├── settings.ts       # App settings
│   └── sources.json      # User configuration
├── sources/
│   ├── twitter.ts        # X API bookmark fetcher
│   ├── gmail.ts          # Gmail newsletter reader
│   └── article-extractor.ts  # URL content extraction
├── processing/
│   ├── summarizer.ts     # Claude API summarization
│   └── digest-builder.ts # Aggregate into digest
├── output/
│   ├── email-template.ts # HTML email template
│   └── gmail-sender.ts   # Gmail sender
└── storage/
    └── digest-store.ts   # JSON persistence
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev -- --run-now` | Run digest immediately |
| `npm run dev -- --daemon` | Run scheduled (stays alive) |
| `npm run test-sources` | Verify API connections |
| `npm run gmail-auth` | Set up Gmail OAuth |

## Troubleshooting

**Twitter API 403 error**: Ensure you have Basic tier ($200/mo) and OAuth 1.0a user context tokens, not just a bearer token.

**Gmail auth fails**: Delete `token.json` and re-run `npm run gmail-auth`.

**No content found**: Check that your Gmail label matches exactly (use label:label-name format in Gmail).

**Article extraction fails**: Some URLs are paywalled or blocked. The digest will proceed with tweet/email text.

## Data Files

- `data/digest-history.json` - Past 30 digests
- `data/processed-ids.json` - Deduplication tracking
- `data/unsent/` - Failed email sends (manual retry)
