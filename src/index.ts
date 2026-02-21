import "dotenv/config";
import { CronJob } from "cron";
import { createLogger } from "./utils/logger.js";
import { settings, sourcesConfig } from "./config/settings.js";
import { fetchNewsletters } from "./sources/gmail.js";
import { fetchTwitterContent } from "./sources/twitter.js";
import { fetchRssFeeds } from "./sources/rss.js";
import { fetchWebScoutResults } from "./sources/web-scout.js";
import { extractArticles } from "./sources/article-extractor.js";
import {
  summarizeItems,
  decomposeNewsletter,
  synthesizeDigest,
  generateExecutiveBrief,
} from "./processing/summarizer.js";
import { buildMemoryArtifacts } from "./processing/memory-builder.js";
import { NoopMemoryProvider, type MemoryProvider } from "./processing/memory-provider.js";
import { buildMemoryRetrievalQuery } from "./processing/memory-retriever.js";
import { buildDigest } from "./processing/digest-builder.js";
import { SqliteMemoryProvider } from "./storage/memory-store.js";
import {
  filterUnprocessed,
  markAsProcessed,
  saveDigest,
} from "./storage/digest-store.js";
import { sendDigestEmail } from "./output/gmail-sender.js";
import type {
  SourceItem,
  SummarizedItem,
  SynthesizedTheme,
  TwitterBookmark,
  GmailNewsletter,
  HistoricalContextPack,
} from "./sources/types.js";

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

async function initMemoryProvider(): Promise<MemoryProvider> {
  if (!sourcesConfig.processing.memory.enabled) {
    return new NoopMemoryProvider("memory disabled by config");
  }

  const provider = new SqliteMemoryProvider(settings.paths.memoryDb);
  try {
    await provider.init();
    return provider;
  } catch (error) {
    logger.warn("Memory provider init failed; continuing without memory", error);
    return new NoopMemoryProvider("memory init failed");
  }
}

function findOrphanedItems(
  allItems: SummarizedItem[],
  themes: SynthesizedTheme[]
): SummarizedItem[] {
  return allItems
    .filter((item) => {
      // Skip low-relevance items
      if (item.aiRelevanceScore < 0.6) return false;

      // Check if item is represented in any theme (reuse pattern from memory-builder)
      const normalizedTitle = item.title.trim().toLowerCase();
      const normalizedUrl = item.url?.trim().toLowerCase();

      const inTheme = themes.some((theme) =>
        theme.sources.some((source) => {
          const sameTitle = source.title?.trim().toLowerCase() === normalizedTitle;
          const sameUrl =
            Boolean(normalizedUrl) &&
            source.url?.trim().toLowerCase() === normalizedUrl;
          return sameTitle || sameUrl;
        })
      );

      return !inTheme;
    })
    .sort((a, b) => b.aiRelevanceScore - a.aiRelevanceScore);
}

async function runDigest(): Promise<void> {
  logger.info("Starting digest generation");
  const errors: string[] = [];
  const sourceFetchErrors: string[] = [];
  const memoryProvider = await initMemoryProvider();

  const stats = {
    twitterCount: 0,
    gmailCount: 0,
    rssCount: 0,
    webScoutCount: 0,
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
  let rssItems: SourceItem[] = [];
  let webScoutItems: SourceItem[] = [];

  const [twitterResult, newslettersResult, rssResult, webScoutResult] = await Promise.allSettled([
    fetchTwitterContent(),
    fetchNewsletters(),
    sourcesConfig.rss?.enabled ? fetchRssFeeds() : Promise.resolve([]),
    sourcesConfig.webScout?.enabled ? fetchWebScoutResults() : Promise.resolve([]),
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
    const errorMessage = "Twitter: " + (twitterResult.reason?.message || "fetch failed");
    errors.push(errorMessage);
    sourceFetchErrors.push(errorMessage);
  }

  if (newslettersResult.status === "fulfilled") {
    newsletters = filterUnprocessed("gmail", newslettersResult.value);
    stats.gmailCount = newsletters.length;
  } else {
    logger.error("Gmail fetch failed", newslettersResult.reason);
    const errorMessage = "Gmail: " + (newslettersResult.reason?.message || "fetch failed");
    errors.push(errorMessage);
    sourceFetchErrors.push(errorMessage);
  }

  if (rssResult.status === "fulfilled") {
    const rawRss = rssResult.value as SourceItem[];
    rssItems = filterUnprocessed("rss", rawRss);
    stats.rssCount = rssItems.length;
    logger.info(`RSS sources: ${rssItems.length} items`);
  } else {
    logger.warn("RSS fetch failed (non-fatal)", rssResult.reason);
    errors.push("RSS: " + (rssResult.reason?.message || "fetch failed"));
  }

  if (webScoutResult.status === "fulfilled") {
    const rawWebScout = webScoutResult.value as SourceItem[];
    webScoutItems = filterUnprocessed("web-scout", rawWebScout);
    stats.webScoutCount = webScoutItems.length;
    logger.info(`Web scout sources: ${webScoutItems.length} items`);
  } else {
    logger.warn("Web scout failed (non-fatal)", webScoutResult.reason);
    errors.push("Web Scout: " + (webScoutResult.reason?.message || "fetch failed"));
  }

  if (sourceFetchErrors.length > 0) {
    throw new Error(
      `Aborting digest to preserve integrity; required source fetch failed (${sourceFetchErrors.join("; ")})`
    );
  }

  const allTwitterContent = [...bookmarks, ...accountTweets];
  if (allTwitterContent.length === 0 && newsletters.length === 0 && rssItems.length === 0 && webScoutItems.length === 0) {
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

  // Phase 2.5: Extract articles for RSS items that have URLs
  if (rssItems.length > 0) {
    const rssUrls = rssItems.flatMap((item) => (item.url ? [item.url] : []));
    if (rssUrls.length > 0) {
      const rssExtractionResult = await extractArticles(rssUrls);
      stats.articlesExtracted += rssExtractionResult.stats.articlesExtracted;
      stats.failedExtractions += rssExtractionResult.stats.failedExtractions;

      for (const item of rssItems) {
        if (item.url) {
          const article = rssExtractionResult.articles.get(item.url);
          if (article?.content) {
            item.content += "\n\n--- Source article content ---\n\n" + article.content;
          }
        }
      }
    }
  }

  // Phase 2.6: Extract articles for web scout items
  if (webScoutItems.length > 0) {
    const webScoutUrls = webScoutItems.flatMap((item) => (item.url ? [item.url] : []));
    if (webScoutUrls.length > 0) {
      const webScoutExtractionResult = await extractArticles(webScoutUrls);
      stats.articlesExtracted += webScoutExtractionResult.stats.articlesExtracted;
      stats.failedExtractions += webScoutExtractionResult.stats.failedExtractions;

      for (const item of webScoutItems) {
        if (item.url) {
          const article = webScoutExtractionResult.articles.get(item.url);
          if (article?.content) {
            item.content += "\n\n--- Source article content ---\n\n" + article.content;
          }
        }
      }
    }
  }

  logger.info(
    `Processing ${bookmarkItems.length} bookmarks, ${accountTweetItems.length} account tweets, ${newsletterStoryItems.length} newsletter stories, ${rssItems.length} RSS items, ${webScoutItems.length} web scout items`
  );

  // Phase 4: Summarize all individual items
  const summarizedBookmarks = await summarizeItems(bookmarkItems);
  const summarizedNewsletterStories = await summarizeItems(newsletterStoryItems);
  const summarizedAccountTweets = accountTweetItems.length > 0
    ? await summarizeItems(accountTweetItems)
    : [];
  const summarizedRss = rssItems.length > 0
    ? await summarizeItems(rssItems)
    : [];
  const summarizedWebScout = webScoutItems.length > 0
    ? await summarizeItems(webScoutItems)
    : [];
  const allSummarized = [...summarizedBookmarks, ...summarizedNewsletterStories, ...summarizedAccountTweets, ...summarizedRss, ...summarizedWebScout];

  let historicalContext: HistoricalContextPack | undefined;
  if (sourcesConfig.processing.memory.enabled) {
    try {
      const query = buildMemoryRetrievalQuery(
        allSummarized,
        sourcesConfig.processing.memory
      );
      historicalContext = await memoryProvider.retrieve(query);
      logger.info(
        `Historical memory retrieved: ${historicalContext.cards.length} cards, ${historicalContext.stats.tokenEstimate} estimated tokens`
      );
    } catch (error) {
      logger.warn("Historical memory retrieval failed; using today-only context", error);
    }
  }

  // Phase 5: Cross-source narrative synthesis
  const themes = await synthesizeDigest(
    allSummarized,
    accountTweetItems,
    historicalContext
  );

  // Phase 5.5: Detect orphaned items (not represented in any theme)
  const alsoNotable = findOrphanedItems(allSummarized, themes);
  if (alsoNotable.length > 0) {
    logger.info(
      `Also Notable: ${alsoNotable.length} items not in themes (${allSummarized.length} total, ${allSummarized.length - alsoNotable.length} in themes)`
    );
  }

  // Phase 6: CAIO executive brief (uses themes + all items)
  const executiveBrief = await generateExecutiveBrief(allSummarized, themes);

  // Phase 7: Build digest
  const digest = buildDigest(allSummarized, themes, executiveBrief, stats, errors, alsoNotable);

  // Send email
  const emailSent = await sendDigestEmail(digest);

  if (!emailSent) {
    throw new Error(
      "Digest generation completed but email delivery failed. Leaving items unprocessed for retry."
    );
  }

  // Only mark as processed after successful delivery.
  saveDigest(digest);
  markAsProcessed(
    "twitter",
    allTwitterContent.map((t) => t.id)
  );
  markAsProcessed(
    "gmail",
    newsletters.map((n) => n.id)
  );
  if (rssItems.length > 0) {
    markAsProcessed(
      "rss",
      rssItems.map((item) => item.id)
    );
  }
  if (webScoutItems.length > 0) {
    markAsProcessed(
      "web-scout",
      webScoutItems.map((item) => item.id)
    );
  }

  if (sourcesConfig.processing.memory.enabled) {
    try {
      const artifacts = buildMemoryArtifacts(digest);
      const runStats = await memoryProvider.ingest(
        artifacts.cards,
        artifacts.links,
        {
          runDate: new Date(),
          retrievalMs: historicalContext?.stats.retrievalMs || 0,
          cardsUsed: historicalContext?.stats.selected || 0,
          tokenOverheadEstimate: historicalContext?.stats.tokenEstimate || 0,
          notes: `daily:${digest.id}`,
        }
      );

      logger.info(
        `Memory ingest stats: created=${runStats.cardsCreated}, merged=${runStats.cardsMerged}, cardsUsed=${runStats.cardsUsed}`
      );

      if (sourcesConfig.processing.memory.compaction.enabled) {
        await memoryProvider.compact(new Date());
      }
    } catch (error) {
      logger.warn("Memory ingest/compaction failed; digest remains successful", error);
    }
  }

  logger.info("Digest complete and sent successfully");
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
  const isDaemon = args.includes("--daemon");

  // Dead-man's switch: kill process after 30 minutes no matter what.
  // Prevents zombie processes from blocking future scheduled runs.
  // Only active for non-daemon mode (--run-now or default single run).
  if (!isDaemon) {
    const PROCESS_TIMEOUT_MS = 45 * 60 * 1000;
    const processTimer = setTimeout(() => {
      logger.error(`Process timeout (${PROCESS_TIMEOUT_MS / 60000}min) — killing to unblock future runs`);
      process.exit(1);
      // Fallback: if process.exit doesn't terminate (e.g. Puppeteer event handlers),
      // force-kill after 3 seconds
      setTimeout(() => {
        process.kill(process.pid, "SIGKILL");
      }, 3000).unref();
    }, PROCESS_TIMEOUT_MS);
    // DO NOT unref — the timer must fire even if the event loop is dominated by I/O
  }

  // Handle SIGTERM gracefully (sent by launchd before SIGKILL)
  process.on("SIGTERM", () => {
    logger.warn("Received SIGTERM — shutting down");
    process.exit(1);
  });

  if (args.includes("--run-now")) {
    logger.info("Running digest immediately (--run-now)");
    await runDigest();
    process.exit(0);
  }

  if (isDaemon) {
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
