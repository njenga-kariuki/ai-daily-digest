/**
 * Test script to verify individual sources work correctly
 * Run: npm run test-sources
 */

import "dotenv/config";
import { createLogger } from "./utils/logger.js";
import { fetchNewsletters } from "./sources/gmail.js";
import { fetchBookmarks } from "./sources/twitter.js";
import { extractArticle } from "./sources/article-extractor.js";

const logger = createLogger("TestSources");

async function testGmail(): Promise<boolean> {
  logger.info("Testing Gmail API...");
  try {
    const newsletters = await fetchNewsletters();
    logger.info(`Gmail: Found ${newsletters.length} newsletters`);
    if (newsletters.length > 0) {
      logger.info(`  First: "${newsletters[0].subject}" from ${newsletters[0].from}`);
      logger.info(`  URLs found: ${newsletters[0].urls.length}`);
    }
    return true;
  } catch (error: any) {
    logger.error("Gmail test failed", error.message);
    return false;
  }
}

async function testTwitter(): Promise<boolean> {
  logger.info("Testing Twitter API...");
  try {
    const result = await fetchBookmarks();
    const bookmarks = result.bookmarks;
    logger.info(`Twitter: Found ${bookmarks.length} bookmarks (${result.threadsExpanded} threads expanded)`);
    if (bookmarks.length > 0) {
      logger.info(`  First: @${bookmarks[0].authorUsername}: ${bookmarks[0].text.slice(0, 60)}...`);
      logger.info(`  URLs found: ${bookmarks[0].urls.length}`);
    }
    return true;
  } catch (error: any) {
    logger.error("Twitter test failed", error.message);
    return false;
  }
}

async function testArticleExtractor(): Promise<boolean> {
  logger.info("Testing Article Extractor...");
  const testUrl = "https://openai.com/blog/chatgpt";

  try {
    const article = await extractArticle(testUrl);
    if (article) {
      logger.info(`Extracted: "${article.title}"`);
      logger.info(`  Content length: ${article.content.length} chars`);
      logger.info(`  Author: ${article.author || "unknown"}`);
      return true;
    } else {
      logger.warn("No content extracted (may be expected for some URLs)");
      return true;
    }
  } catch (error: any) {
    logger.error("Article extraction test failed", error.message);
    return false;
  }
}

async function main() {
  logger.info("=== AI Daily Digest Source Tests ===\n");

  const results = {
    gmail: await testGmail(),
    twitter: await testTwitter(),
    articleExtractor: await testArticleExtractor(),
  };

  logger.info("\n=== Results ===");
  for (const [name, passed] of Object.entries(results)) {
    logger.info(`  ${name}: ${passed ? "✓ PASS" : "✗ FAIL"}`);
  }

  const allPassed = Object.values(results).every((r) => r);
  process.exit(allPassed ? 0 : 1);
}

main();
