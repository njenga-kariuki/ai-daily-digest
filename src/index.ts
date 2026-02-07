import "dotenv/config";
import { CronJob } from "cron";
import { createLogger } from "./utils/logger.js";
import { sourcesConfig } from "./config/settings.js";
import { fetchNewsletters } from "./sources/gmail.js";
import { fetchTwitterContent } from "./sources/twitter.js";
import { extractArticles } from "./sources/article-extractor.js";
import {
  summarizeItems,
  decomposeNewsletter,
  synthesizeDigest,
  generateExecutiveBrief,
} from "./processing/summarizer.js";
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
    twitterSourceType: bookmark.sourceType,
    sourceAccount: bookmark.sourceAccount,
  };
}

function extractNewsletterName(from: string): string {
  // Extract name from "Name <email>" or just return the from string
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : from;
}

async function runDigest(): Promise<void> {
  logger.info("Starting digest generation");
  const errors: string[] = [];

  const stats = {
    twitterCount: 0,
    gmailCount: 0,
    articlesExtracted: 0,
    failedExtractions: 0,
    youtubeWithTranscript: 0,
    youtubeMetadataOnly: 0,
    threadsExpanded: 0,
  };

  // Fetch sources in parallel
  let bookmarks: TwitterBookmark[] = [];
  let accountTweets: TwitterBookmark[] = [];
  let newsletters: GmailNewsletter[] = [];

  const [twitterResult, newslettersResult] = await Promise.allSettled([
    fetchTwitterContent(),
    fetchNewsletters(),
  ]);

  if (twitterResult.status === "fulfilled") {
    const { bookmarks: rawBookmarks, accountTweets: rawAccountTweets, threadsExpanded } = twitterResult.value;
    bookmarks = filterUnprocessed("twitter", rawBookmarks);
    accountTweets = filterUnprocessed("twitter", rawAccountTweets);
    stats.twitterCount = bookmarks.length + accountTweets.length;
    stats.threadsExpanded = threadsExpanded;
    logger.info(
      `Twitter sources: ${bookmarks.length} bookmarks, ${accountTweets.length} from monitored accounts`
    );
  } else {
    logger.error("Twitter fetch failed", twitterResult.reason);
    errors.push("Twitter: " + (twitterResult.reason?.message || "fetch failed"));
  }

  if (newslettersResult.status === "fulfilled") {
    newsletters = filterUnprocessed("gmail", newslettersResult.value);
    stats.gmailCount = newsletters.length;
  } else {
    logger.error("Gmail fetch failed", newslettersResult.reason);
    errors.push("Gmail: " + (newslettersResult.reason?.message || "fetch failed"));
  }

  const allTwitterContent = [...bookmarks, ...accountTweets];
  if (allTwitterContent.length === 0 && newsletters.length === 0) {
    logger.warn("No new content to process");
    return;
  }

  // Phase 1: Extract articles for Twitter bookmarks only
  const twitterUrls = allTwitterContent.flatMap((b) => b.urls);
  const extractionResult = await extractArticles(twitterUrls);
  const extractedArticles = extractionResult.articles;
  stats.articlesExtracted = extractionResult.stats.articlesExtracted;
  stats.failedExtractions = extractionResult.stats.failedExtractions;
  stats.youtubeWithTranscript = extractionResult.stats.youtubeWithTranscript;
  stats.youtubeMetadataOnly = extractionResult.stats.youtubeMetadataOnly;

  // Convert Twitter content to SourceItems
  const bookmarkItems: SourceItem[] = [];
  const accountTweetItems: SourceItem[] = [];

  for (const tweet of bookmarks) {
    const articleUrl = tweet.urls[0];
    const article = articleUrl ? extractedArticles.get(articleUrl) : undefined;
    bookmarkItems.push(twitterToSourceItem(tweet, article?.content));
  }

  for (const tweet of accountTweets) {
    const articleUrl = tweet.urls[0];
    const article = articleUrl ? extractedArticles.get(articleUrl) : undefined;
    accountTweetItems.push(twitterToSourceItem(tweet, article?.content));
  }

  // Phase 2: Decompose newsletters into individual stories
  const newsletterStoryItems: SourceItem[] = [];
  for (const newsletter of newsletters) {
    const stories = await decomposeNewsletter(newsletter);
    const nonSponsored = stories.filter((s) => !s.isSponsored);

    for (let i = 0; i < nonSponsored.length; i++) {
      const story = nonSponsored[i];
      newsletterStoryItems.push({
        id: `gmail-${newsletter.id}-${i}`,
        source: "gmail",
        title: story.title,
        content: story.content,
        url: story.urls[0],
        author: newsletter.from,
        publishedAt: newsletter.receivedAt,
        extractedAt: new Date(),
        parentNewsletterId: newsletter.id,
        newsletterName: extractNewsletterName(newsletter.from),
      });
    }
  }

  // Phase 3: Extract articles from story-level URLs to enrich content
  const storyUrls = newsletterStoryItems.flatMap((s) =>
    s.url ? [s.url] : []
  );
  if (storyUrls.length > 0) {
    const storyExtractionResult = await extractArticles(storyUrls);
    stats.articlesExtracted += storyExtractionResult.stats.articlesExtracted;
    stats.failedExtractions += storyExtractionResult.stats.failedExtractions;

    for (const item of newsletterStoryItems) {
      if (item.url) {
        const article = storyExtractionResult.articles.get(item.url);
        if (article?.content) {
          item.content +=
            "\n\n--- Source article content ---\n\n" + article.content;
        }
      }
    }
  }

  logger.info(
    `Processing ${bookmarkItems.length} bookmarks, ${accountTweetItems.length} account tweets, ${newsletterStoryItems.length} newsletter stories`
  );

  // Phase 4: Summarize all individual items
  const summarizedBookmarks = await summarizeItems(bookmarkItems);
  const summarizedNewsletterStories = await summarizeItems(newsletterStoryItems);
  const allSummarized = [...summarizedBookmarks, ...summarizedNewsletterStories];

  // Phase 5: Cross-source narrative synthesis
  const themes = await synthesizeDigest(allSummarized, accountTweetItems);

  // Phase 6: CAIO executive brief (uses themes + all items)
  const executiveBrief = await generateExecutiveBrief(allSummarized, themes);

  // Phase 7: Build digest
  const digest = buildDigest(allSummarized, themes, executiveBrief, stats, errors);

  // Send email
  const emailSent = await sendDigestEmail(digest);

  // Save digest and mark items as processed
  saveDigest(digest);
  markAsProcessed(
    "twitter",
    allTwitterContent.map((t) => t.id)
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
