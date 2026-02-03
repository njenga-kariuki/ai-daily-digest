import "dotenv/config";
import { CronJob } from "cron";
import { createLogger } from "./utils/logger.js";
import { sourcesConfig } from "./config/settings.js";
import { fetchNewsletters } from "./sources/gmail.js";
import { fetchBookmarks } from "./sources/twitter.js";
import { extractArticles } from "./sources/article-extractor.js";
import { summarizeItems } from "./processing/summarizer.js";
import { buildDigest } from "./processing/digest-builder.js";
import {
  filterUnprocessed,
  markAsProcessed,
  saveDigest,
} from "./storage/digest-store.js";
import { sendDigestEmail } from "./output/gmail-sender.js";
import type { SourceItem, TwitterBookmark, GmailNewsletter } from "./sources/types.js";

const logger = createLogger("Main");

function twitterToSourceItem(
  bookmark: TwitterBookmark,
  articleContent?: string
): SourceItem {
  return {
    id: `twitter-${bookmark.id}`,
    source: "twitter",
    title: `@${bookmark.authorUsername}: ${bookmark.text.slice(0, 80)}...`,
    content: articleContent || bookmark.text,
    url: bookmark.urls[0],
    author: bookmark.authorName,
    publishedAt: bookmark.createdAt,
    extractedAt: new Date(),
  };
}

function gmailToSourceItem(
  newsletter: GmailNewsletter,
  articleContent?: string
): SourceItem {
  return {
    id: `gmail-${newsletter.id}`,
    source: "gmail",
    title: newsletter.subject,
    content: articleContent || newsletter.body,
    url: newsletter.urls[0],
    author: newsletter.from,
    publishedAt: newsletter.receivedAt,
    extractedAt: new Date(),
  };
}

async function runDigest(): Promise<void> {
  logger.info("Starting digest generation");
  const errors: string[] = [];

  // Stats tracking
  const stats = {
    twitterCount: 0,
    gmailCount: 0,
    articlesExtracted: 0,
    failedExtractions: 0,
  };

  // Fetch sources in parallel
  let bookmarks: TwitterBookmark[] = [];
  let newsletters: GmailNewsletter[] = [];

  const [bookmarksResult, newslettersResult] = await Promise.allSettled([
    fetchBookmarks(),
    fetchNewsletters(),
  ]);

  if (bookmarksResult.status === "fulfilled") {
    bookmarks = filterUnprocessed("twitter", bookmarksResult.value);
    stats.twitterCount = bookmarks.length;
  } else {
    logger.error("Twitter fetch failed", bookmarksResult.reason);
    errors.push("Twitter: " + (bookmarksResult.reason?.message || "fetch failed"));
  }

  if (newslettersResult.status === "fulfilled") {
    newsletters = filterUnprocessed("gmail", newslettersResult.value);
    stats.gmailCount = newsletters.length;
  } else {
    logger.error("Gmail fetch failed", newslettersResult.reason);
    errors.push("Gmail: " + (newslettersResult.reason?.message || "fetch failed"));
  }

  if (bookmarks.length === 0 && newsletters.length === 0) {
    logger.warn("No new content to process");
    return;
  }

  // Collect all URLs for article extraction
  const allUrls = [
    ...bookmarks.flatMap((b) => b.urls),
    ...newsletters.flatMap((n) => n.urls),
  ];

  // Extract article content
  const extractedArticles = await extractArticles(allUrls);
  stats.articlesExtracted = extractedArticles.size;
  stats.failedExtractions = allUrls.length - extractedArticles.size;

  // Convert to SourceItems
  const sourceItems: SourceItem[] = [];

  for (const bookmark of bookmarks) {
    const articleUrl = bookmark.urls[0];
    const article = articleUrl ? extractedArticles.get(articleUrl) : undefined;
    sourceItems.push(twitterToSourceItem(bookmark, article?.content));
  }

  for (const newsletter of newsletters) {
    const articleUrl = newsletter.urls[0];
    const article = articleUrl ? extractedArticles.get(articleUrl) : undefined;
    sourceItems.push(gmailToSourceItem(newsletter, article?.content));
  }

  logger.info(`Processing ${sourceItems.length} source items`);

  // Summarize with Claude
  const summarizedItems = await summarizeItems(sourceItems);

  // Build digest
  const digest = await buildDigest(summarizedItems, stats, errors);

  // Send email
  const emailSent = await sendDigestEmail(digest);

  // Save digest and mark items as processed
  saveDigest(digest);
  markAsProcessed(
    "twitter",
    bookmarks.map((b) => b.id)
  );
  markAsProcessed(
    "gmail",
    newsletters.map((n) => n.id)
  );

  if (emailSent) {
    logger.info("Digest complete and sent successfully");
  } else {
    logger.warn("Digest complete but email failed to send");
  }
}

function startScheduler(): void {
  const { digestTime, timezone } = sourcesConfig.output;
  const [hour, minute] = digestTime.split(":").map(Number);

  const cronExpression = `0 ${minute} ${hour} * * *`;
  logger.info(`Scheduling digest for ${digestTime} ${timezone}`);

  const job = new CronJob(
    cronExpression,
    async () => {
      try {
        await runDigest();
      } catch (error) {
        logger.error("Scheduled digest failed", error);
      }
    },
    null,
    true,
    timezone
  );

  job.start();
  logger.info("Scheduler started");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--run-now")) {
    logger.info("Running digest immediately (--run-now)");
    await runDigest();
    process.exit(0);
  }

  if (args.includes("--daemon")) {
    logger.info("Starting in daemon mode");
    startScheduler();
    // Keep process alive
    process.on("SIGINT", () => {
      logger.info("Shutting down");
      process.exit(0);
    });
  } else {
    // Default: run once
    await runDigest();
  }
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
