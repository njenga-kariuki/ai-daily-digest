import { extract } from "@extractus/article-extractor";
import { createLogger } from "../utils/logger.js";
import type { ExtractedArticle } from "./types.js";

const logger = createLogger("ArticleExtractor");

// Domains known to be paywalled or problematic
const SKIP_DOMAINS = [
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "github.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
];

function shouldSkipUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SKIP_DOMAINS.some((domain) => hostname.includes(domain));
  } catch {
    return true;
  }
}

export async function extractArticle(
  url: string
): Promise<ExtractedArticle | null> {
  if (shouldSkipUrl(url)) {
    logger.debug(`Skipping URL: ${url}`);
    return null;
  }

  try {
    logger.debug(`Extracting article: ${url}`);

    const article = await extract(url);

    if (!article || !article.content) {
      logger.debug(`No content extracted from: ${url}`);
      return null;
    }

    // Clean up the content - remove HTML tags
    const cleanContent = article.content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Skip if content is too short (likely failed extraction)
    if (cleanContent.length < 200) {
      logger.debug(`Content too short from: ${url}`);
      return null;
    }

    return {
      url,
      title: article.title || "Untitled",
      content: cleanContent,
      author: article.author || undefined,
      publishedAt: article.published ? new Date(article.published) : undefined,
      siteName: article.source || undefined,
    };
  } catch (error) {
    logger.debug(`Failed to extract: ${url}`, error);
    return null;
  }
}

export async function extractArticles(
  urls: string[]
): Promise<Map<string, ExtractedArticle>> {
  const uniqueUrls = [...new Set(urls)];
  logger.info(`Extracting ${uniqueUrls.length} unique URLs`);

  const results = new Map<string, ExtractedArticle>();
  let successCount = 0;
  let failCount = 0;

  // Process in batches to avoid overwhelming servers
  const batchSize = 5;
  for (let i = 0; i < uniqueUrls.length; i += batchSize) {
    const batch = uniqueUrls.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map((url) => extractArticle(url))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const url = batch[j];

      if (result.status === "fulfilled" && result.value) {
        results.set(url, result.value);
        successCount++;
      } else {
        failCount++;
      }
    }

    // Small delay between batches
    if (i + batchSize < uniqueUrls.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.info(
    `Extracted ${successCount} articles, ${failCount} failed/skipped`
  );
  return results;
}
