# AI Daily Digest

A personal research system that turns newsletters, saved links and public feeds into a daily AI briefing, with memory of what has already been covered.

Built in 2026 by Njenga Kariuki to make a high-volume research habit useful for decisions: identify the signal, connect it to earlier developments and deliver a readable email with sources.

## How it works

1. Collects material from Gmail newsletters, X bookmarks and selected accounts, RSS feeds and web searches.
2. Extracts article text, GitHub README content and YouTube transcripts, with browser fallbacks for difficult pages.
3. Scores relevance and synthesizes a briefing using Claude and a configurable reader context.
4. Retrieves earlier developments from a SQLite memory store, linking the current briefing to prior coverage.
5. Sends the email through Gmail and records processed items to reduce repetition. A local scheduler wrapper adds retries, a watchdog and failure notifications.

The implementation includes source-level error handling, extraction diagnostics, persistent memory and email delivery. Source availability and model/API access vary; the repository contains the code and configuration examples, while account credentials and reading history stay local.

## Run locally

Use Node.js with npm. Install dependencies with `npm ci`, copy `.env.example` to `.env`, and configure the services you want to use. Edit `src/config/sources.json` to choose feeds, topics, schedule and your recipient email.

For Gmail, create your own Google OAuth desktop-app credentials, save them as `credentials.json`, then run `npm run gmail-auth`. Both that file and the resulting `token.json` are ignored by Git. X bookmark access requires suitable API permissions; public feeds provide additional inputs.

Run `npm run dev -- --run-now` for one digest, or `npm run dev -- --daemon` for the schedule. Runs can make paid API calls and send an email to the configured recipient.

Optional reader context belongs in local Markdown files under `config/caio-context/`. The fallback is generic. Generated digests, bookmarks, tokens and the memory database are excluded from this public source release.

## Explore the implementation

- `src/sources/`: collection and extraction adapters
- `src/processing/`: relevance, synthesis and memory retrieval
- `src/storage/`: digest history and longitudinal memory
- `scripts/run-digest.sh`: local scheduling resilience
- `CLAUDE.md`: developer notes and diagnostic commands

Development began in February 2026. This source release preserves that development history; it does not promise that every external source or historical model configuration is currently available.
