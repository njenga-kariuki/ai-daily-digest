import Parser from "rss-parser";
import { createLogger } from "../utils/logger.js";
import { sourcesConfig } from "../config/settings.js";
import type { SourceItem } from "./types.js";

const logger = createLogger("RSS");

const parser = new Parser({
  timeout: 15_000,
  headers: {
    "User-Agent": "AI-Daily-Digest/1.0",
  },
});

interface RssFeedConfig {
  name: string;
  url: string;
  category: string;
}

export async function fetchRssFeeds(): Promise<SourceItem[]> {
  const rssConfig = sourcesConfig.rss;
  if (!rssConfig?.enabled) {
    logger.info("RSS feeds disabled");
    return [];
  }

  const feeds: RssFeedConfig[] = rssConfig.feeds || [];
  const lookbackMs = (rssConfig.lookbackHours || 24) * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - lookbackMs);
  const maxPerFeed = rssConfig.maxItemsPerFeed || 5;

  logger.info(`Fetching ${feeds.length} RSS feeds (lookback: ${rssConfig.lookbackHours}h)`);

  const results: SourceItem[] = [];
  const feedResults = await Promise.allSettled(
    feeds.map((feed) => fetchSingleFeed(feed, cutoff, maxPerFeed))
  );

  let successCount = 0;
  for (let i = 0; i < feedResults.length; i++) {
    const result = feedResults[i];
    if (result.status === "fulfilled") {
      results.push(...result.value);
      if (result.value.length > 0) successCount++;
    } else {
      logger.warn(`Failed to fetch feed "${feeds[i].name}": ${result.reason?.message || "unknown error"}`);
    }
  }

  logger.info(`RSS sources: ${results.length} items from ${successCount}/${feeds.length} feeds`);
  return results;
}

async function fetchSingleFeed(
  feed: RssFeedConfig,
  cutoff: Date,
  maxItems: number
): Promise<SourceItem[]> {
  const parsed = await parser.parseURL(feed.url);
  const items: SourceItem[] = [];

  for (const entry of parsed.items || []) {
    if (items.length >= maxItems) break;

    const pubDate = entry.pubDate ? new Date(entry.pubDate) : null;
    if (pubDate && pubDate < cutoff) continue;

    const content = entry["content:encoded"] || entry.content || entry.contentSnippet || entry.summary || "";
    const title = entry.title || "Untitled";

    items.push({
      id: `rss-${feed.name}-${entry.guid || entry.link || title}`,
      source: "rss",
      title,
      content: stripHtmlTags(content),
      url: entry.link || undefined,
      author: entry.creator || entry.author || feed.name,
      publishedAt: pubDate || new Date(),
      extractedAt: new Date(),
      feedName: feed.name,
    });
  }

  if (items.length > 0) {
    logger.debug(`Feed "${feed.name}": ${items.length} items`);
  }

  return items;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
