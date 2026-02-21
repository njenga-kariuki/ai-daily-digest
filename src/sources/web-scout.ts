import { createLogger } from "../utils/logger.js";
import { sourcesConfig } from "../config/settings.js";
import type { SourceItem } from "./types.js";

const logger = createLogger("WebScout");

const BRAVE_API_BASE = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
}

interface BraveSearchResponse {
  web?: {
    results: BraveSearchResult[];
  };
}

interface ScoutQuery {
  query: string;
  category: string;
}

export async function fetchWebScoutResults(): Promise<SourceItem[]> {
  const config = sourcesConfig.webScout;
  if (!config?.enabled) {
    logger.info("Web scout disabled");
    return [];
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    logger.warn("BRAVE_SEARCH_API_KEY not set — skipping web scout");
    return [];
  }

  const queries = config.queries.slice(0, config.maxQueriesPerRun || 6);
  const maxPerQuery = config.maxResultsPerQuery || 5;

  logger.info(`Web scout: running ${queries.length} queries`);

  const results: SourceItem[] = [];
  const seenUrls = new Set<string>();

  const queryResults = await Promise.allSettled(
    queries.map((q) => runBraveSearch(apiKey, q, maxPerQuery))
  );

  for (let i = 0; i < queryResults.length; i++) {
    const result = queryResults[i];
    if (result.status === "fulfilled") {
      for (const item of result.value) {
        // Deduplicate by URL within this run
        const normalizedUrl = item.url?.toLowerCase();
        if (normalizedUrl && seenUrls.has(normalizedUrl)) continue;
        if (normalizedUrl) seenUrls.add(normalizedUrl);
        results.push(item);
      }
    } else {
      logger.warn(
        `Web scout query "${queries[i].query}" failed: ${result.reason?.message || "unknown"}`
      );
    }
  }

  logger.info(`Web scout: ${results.length} results from ${queries.length} queries`);
  return results;
}

async function runBraveSearch(
  apiKey: string,
  query: ScoutQuery,
  maxResults: number
): Promise<SourceItem[]> {
  const params = new URLSearchParams({
    q: query.query,
    count: String(maxResults),
    freshness: "pd", // past day
  });

  const response = await fetch(`${BRAVE_API_BASE}?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  const webResults = data.web?.results || [];

  return webResults.map((result) => ({
    id: `web-scout-${query.category}-${Buffer.from(result.url).toString("base64url").slice(0, 32)}`,
    source: "web-scout" as const,
    title: result.title,
    content: result.description,
    url: result.url,
    author: new URL(result.url).hostname,
    publishedAt: new Date(),
    extractedAt: new Date(),
    feedName: `Scout: ${query.category}`,
  }));
}
