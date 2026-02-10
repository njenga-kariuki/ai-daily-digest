import { extract } from "@extractus/article-extractor";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { createLogger } from "../utils/logger.js";
import type { ExtractedArticle } from "./types.js";
import {
  extractGitHubContent,
  isGitHubUrl,
  resetGitHubApiCounter,
} from "./github-extractor.js";
import { extractYouTubeContent, isYouTubeUrl } from "./youtube-extractor.js";
import {
  extractWithPuppeteer,
  isJsHeavySite,
  clearPuppeteerCache,
} from "./puppeteer-fallback.js";

const logger = createLogger("ArticleExtractor");

// Domains that should be completely skipped (social media without useful article content)
const SKIP_DOMAINS = [
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
];

// User agents for rotation
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function shouldSkipUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SKIP_DOMAINS.some((domain) => hostname.includes(domain));
  } catch {
    return true;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  retries = 3
): Promise<string | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          "User-Agent": getRandomUserAgent(),
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });

      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          return null; // Don't retry permanent errors
        }
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      logger.debug(`Attempt ${attempt + 1} failed for ${url}:`, error);

      if (attempt < retries - 1) {
        // Exponential backoff: 1s, 3s
        await sleep(Math.pow(3, attempt) * 1000);
      }
    }
  }

  return null;
}

async function extractWithReadability(
  url: string,
  html: string
): Promise<ExtractedArticle | null> {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return null;
    }

    const content = article.textContent.replace(/\s+/g, " ").trim();

    if (content.length < 200) {
      return null;
    }

    return {
      url,
      title: article.title || "Untitled",
      content,
      author: article.byline || undefined,
      siteName: article.siteName || undefined,
    };
  } catch (error) {
    logger.debug(`Readability extraction failed for ${url}:`, error);
    return null;
  }
}

async function extractWithExtractus(
  url: string
): Promise<ExtractedArticle | null> {
  try {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const article = await Promise.race([
      extract(url),
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), 15000);
      }),
    ]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (!article || !article.content) {
      return null;
    }

    // Clean up the content - remove HTML tags
    const cleanContent = article.content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleanContent.length < 200) {
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
    logger.debug(`Extractus extraction failed for ${url}:`, error);
    return null;
  }
}

async function resolveUrl(url: string): Promise<string> {
  if (!url.includes('t.co/')) return url;
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return response.url;
  } catch {
    return url;
  }
}

const EXTRACTION_TIMEOUT_MS = 60_000;

async function extractArticleInner(
  url: string
): Promise<ExtractedArticle | null> {
  // Resolve t.co shortened URLs first
  const resolvedUrl = await resolveUrl(url);
  if (resolvedUrl !== url) {
    logger.debug(`Resolved ${url} -> ${resolvedUrl}`);
  }

  // Skip social media domains
  if (shouldSkipUrl(resolvedUrl)) {
    logger.debug(`Skipping URL: ${resolvedUrl}`);
    return null;
  }

  // Handle GitHub URLs specially
  if (isGitHubUrl(resolvedUrl)) {
    logger.debug(`Using GitHub extractor for: ${resolvedUrl}`);
    return extractGitHubContent(resolvedUrl);
  }

  // Handle YouTube URLs specially
  if (isYouTubeUrl(resolvedUrl)) {
    logger.debug(`Using YouTube extractor for: ${resolvedUrl}`);
    return extractYouTubeContent(resolvedUrl);
  }

  logger.debug(`Extracting article: ${resolvedUrl}`);

  // Phase 1: Try @extractus/article-extractor
  let result = await extractWithExtractus(resolvedUrl);
  if (result) {
    return result;
  }

  // Phase 2: Try @mozilla/readability with raw HTML fetch
  const html = await fetchWithRetry(resolvedUrl);
  if (html) {
    result = await extractWithReadability(resolvedUrl, html);
    if (result) {
      return result;
    }
  }

  // Phase 3: For JS-heavy sites or when both extractors fail, try Puppeteer
  if (isJsHeavySite(resolvedUrl) || (!result && html && html.length > 1000)) {
    logger.debug(`Trying Puppeteer fallback for: ${resolvedUrl}`);
    result = await extractWithPuppeteer(resolvedUrl);
    if (result) {
      return result;
    }
  }

  logger.debug(`All extraction methods failed for: ${resolvedUrl}`);
  return null;
}

export async function extractArticle(
  url: string
): Promise<ExtractedArticle | null> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const result = await Promise.race([
    extractArticleInner(url),
    new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => {
        logger.warn(`Extraction timeout (${EXTRACTION_TIMEOUT_MS / 1000}s) for: ${url}`);
        resolve(null);
      }, EXTRACTION_TIMEOUT_MS);
    }),
  ]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  return result;
}

export interface ExtractionStats {
  articlesExtracted: number;
  failedExtractions: number;
  youtubeWithTranscript: number;
  youtubeMetadataOnly: number;
}

export interface ExtractionResult {
  articles: Map<string, ExtractedArticle>;
  stats: ExtractionStats;
}

export async function extractArticles(
  urls: string[]
): Promise<ExtractionResult> {
  const uniqueUrls = [...new Set(urls)];
  logger.info(`Extracting ${uniqueUrls.length} unique URLs`);

  // Reset counters for new batch
  resetGitHubApiCounter();
  clearPuppeteerCache();

  const results = new Map<string, ExtractedArticle>();
  let successCount = 0;
  let failCount = 0;
  let youtubeWithTranscript = 0;
  let youtubeMetadataOnly = 0;

  // Categorize URLs for optimized processing
  const githubUrls: string[] = [];
  const youtubeUrls: string[] = [];
  const regularUrls: string[] = [];

  for (const url of uniqueUrls) {
    if (shouldSkipUrl(url)) {
      failCount++;
    } else if (isGitHubUrl(url)) {
      githubUrls.push(url);
    } else if (isYouTubeUrl(url)) {
      youtubeUrls.push(url);
    } else {
      regularUrls.push(url);
    }
  }

  logger.info(
    `URL breakdown: ${regularUrls.length} regular, ${githubUrls.length} GitHub, ${youtubeUrls.length} YouTube, ${failCount} skipped`
  );

  // Process regular URLs in batches
  const batchSize = 5;
  for (let i = 0; i < regularUrls.length; i += batchSize) {
    const batch = regularUrls.slice(i, i + batchSize);

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
    if (i + batchSize < regularUrls.length) {
      await sleep(500);
    }
  }

  // Process GitHub URLs (already rate-limited internally)
  for (const url of githubUrls) {
    const result = await extractGitHubContent(url);
    if (result) {
      results.set(url, result);
      successCount++;
    } else {
      failCount++;
    }
  }

  // Process YouTube URLs sequentially (has internal delay for rate limiting)
  for (const url of youtubeUrls) {
    const result = await extractYouTubeContent(url);
    if (result) {
      results.set(url, result);
      successCount++;
      // Track YouTube quality metrics
      if (result.hasTranscript) {
        youtubeWithTranscript++;
      } else {
        youtubeMetadataOnly++;
      }
    } else {
      failCount++;
    }
  }

  logger.info(
    `Extracted ${successCount} articles, ${failCount} failed/skipped`
  );
  if (youtubeUrls.length > 0) {
    logger.info(
      `YouTube: ${youtubeWithTranscript} with transcripts, ${youtubeMetadataOnly} metadata-only`
    );
  }

  return {
    articles: results,
    stats: {
      articlesExtracted: successCount,
      failedExtractions: failCount,
      youtubeWithTranscript,
      youtubeMetadataOnly,
    },
  };
}
