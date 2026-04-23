import "dotenv/config";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import {
  getTwitterClient,
  fetchThreadContent,
  extractUrls,
} from "../src/sources/twitter.js";
import { extractArticles } from "../src/sources/article-extractor.js";
import { createLogger } from "../src/utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("BookmarkExport");
const anthropic = new Anthropic();

// Output path — caio-assistant/data/
const OUTPUT_DIR = join(__dirname, "../../caio-assistant/data");
const OUTPUT_FILE = join(OUTPUT_DIR, "bookmarks-enriched.json");

// Load role description for classification prompt
const ROLE_DESCRIPTION = readFileSync(
  join(__dirname, "../../caio-assistant/config/role-description.md"),
  "utf-8"
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Types ---

interface BookmarkRaw {
  id: string;
  text: string;
  authorName: string;
  authorUsername: string;
  authorId?: string;
  createdAt: string;
  urls: string[];
  conversationId?: string;
}

interface ClassificationResult {
  relevant: boolean;
  relevanceScore: number;
  whyRelevant: string;
  themeHints: string[];
}

interface EnrichedBookmark {
  id: string;
  text: string;
  authorName: string;
  authorUsername: string;
  createdAt: string;
  urls: string[];
  relevanceScore: number;
  whyRelevant: string;
  themeHints: string[];
  threadContent?: string;
  articles: Array<{
    url: string;
    title: string;
    content: string;
    author?: string;
    siteName?: string;
  }>;
}

interface ExportOutput {
  exportedAt: string;
  stats: {
    totalFetched: number;
    relevant: number;
    excluded: number;
    threadsExpanded: number;
    articlesExtracted: number;
    articlesFailed: number;
    youtubeTranscripts: number;
  };
  dateRange: { oldest: string; newest: string };
  bookmarks: EnrichedBookmark[];
}

// --- Step 1a: Fetch All Bookmarks (paginate up to 800) ---

async function fetchAllBookmarks(): Promise<BookmarkRaw[]> {
  logger.info("Step 1a: Fetching all bookmarks...");
  const client = await getTwitterClient();

  const allBookmarks: BookmarkRaw[] = [];
  let paginationToken: string | undefined;
  let page = 0;

  do {
    page++;
    logger.info(`Fetching bookmark page ${page}...`);

    const params: Record<string, unknown> = {
      max_results: 100,
      expansions: ["author_id"],
      "tweet.fields": ["created_at", "entities", "text", "conversation_id"],
      "user.fields": ["name", "username"],
    };
    if (paginationToken) {
      params.pagination_token = paginationToken;
    }

    const response = await client.v2.bookmarks(
      params as Parameters<typeof client.v2.bookmarks>[0]
    );

    const users = new Map(
      (response.includes?.users || []).map((u) => [u.id, u])
    );

    const tweets = (response.data.data || []) as Array<{
      id: string;
      text: string;
      author_id?: string;
      conversation_id?: string;
      created_at?: string;
      entities?: { urls?: Array<{ expanded_url?: string }> };
    }>;

    for (const tweet of tweets) {
      const author = users.get(tweet.author_id || "");

      // Extract URLs from entities and text
      const urls: string[] = [];
      if (tweet.entities?.urls) {
        for (const urlEntity of tweet.entities.urls) {
          if (urlEntity.expanded_url) {
            urls.push(urlEntity.expanded_url);
          }
        }
      }
      urls.push(...extractUrls(tweet.text));
      const uniqueUrls = [...new Set(urls)].filter(
        (url) => !url.includes("twitter.com") && !url.includes("x.com")
      );

      allBookmarks.push({
        id: tweet.id,
        text: tweet.text,
        authorName: author?.name || "Unknown",
        authorUsername: author?.username || "unknown",
        authorId: tweet.author_id,
        createdAt: tweet.created_at || new Date().toISOString(),
        urls: uniqueUrls,
        conversationId: tweet.conversation_id,
      });
    }

    paginationToken = response.meta?.next_token;

    logger.info(
      `Page ${page}: ${tweets.length} bookmarks (total: ${allBookmarks.length})`
    );

    if (paginationToken) {
      await sleep(1000);
    }
  } while (paginationToken);

  logger.info(`Fetched ${allBookmarks.length} total bookmarks`);
  return allBookmarks;
}

// --- Step 1b: Inclusive Classification ---

async function classifyBookmarks(
  bookmarks: BookmarkRaw[]
): Promise<Map<string, ClassificationResult>> {
  logger.info(`Step 1b: Classifying ${bookmarks.length} bookmarks...`);

  const results = new Map<string, ClassificationResult>();
  const batchSize = 20;

  for (let i = 0; i < bookmarks.length; i += batchSize) {
    const batch = bookmarks.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(bookmarks.length / batchSize);

    logger.info(`Classification batch ${batchNum}/${totalBatches}...`);

    const bookmarkList = batch
      .map(
        (b, idx) =>
          `[${idx + 1}] @${b.authorUsername}: ${b.text.slice(0, 300)}${
            b.urls.length > 0 ? `\n    URLs: ${b.urls.join(", ")}` : ""
          }`
      )
      .join("\n\n");

    const prompt = `You are classifying bookmarks for relevance to a Chief AI Officer role at Safaricom M-Pesa Africa.

ROLE CONTEXT:
${ROLE_DESCRIPTION}

Given this CAIO role (responsible for AI strategy, architecture, governance, use-case delivery across fintech/payments/7 African markets, AI CoE, partnerships with hyperscalers), assess each bookmark:

Could this — directly or indirectly — inform ANY aspect of the CAIO role?
Including but not limited to: AI/ML technology, LLMs, agents, MLOps, data platforms, fintech, payments, mobile money, African markets, enterprise transformation, leadership, team building, organizational change, governance, ethics, regulation, product thinking, developer ecosystems, vendor landscape, or any adjacent competency.

ONLY exclude bookmarks that are genuinely, unambiguously irrelevant to ANY professional context.
When in doubt → include.

BOOKMARKS TO CLASSIFY:
${bookmarkList}

For each bookmark (by number), respond in JSON format:
{
  "classifications": [
    {
      "index": 1,
      "relevant": true,
      "relevanceScore": 0.85,
      "whyRelevant": "one-line explanation",
      "themeHints": ["theme1", "theme2", "theme3"]
    }
  ]
}

Rules:
- relevanceScore: 0.0-1.0 (0.9+ = directly AI/fintech, 0.5-0.9 = adjacent/useful, <0.5 = tangential but keep if >0.3)
- themeHints: 2-4 labels that emerge NATURALLY from the content (don't force into predefined categories)
- Set relevant=false ONLY for genuinely, unambiguously irrelevant content (personal memes, sports, entertainment, etc.)`;

    try {
      const response = await anthropic.messages.create(
        {
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        },
        { timeout: 90_000 }
      );

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        const classifications = result.classifications || [];

        for (const c of classifications) {
          const bookmark = batch[c.index - 1];
          if (bookmark) {
            results.set(bookmark.id, {
              relevant: c.relevant,
              relevanceScore: c.relevanceScore,
              whyRelevant: c.whyRelevant || "",
              themeHints: c.themeHints || [],
            });
          }
        }
      }
    } catch (error) {
      logger.error(`Classification batch ${batchNum} failed:`, error);
      // On failure, mark all as relevant (inclusive fallback)
      for (const b of batch) {
        results.set(b.id, {
          relevant: true,
          relevanceScore: 0.5,
          whyRelevant: "Classification failed — included by default",
          themeHints: ["unclassified"],
        });
      }
    }

    if (i + batchSize < bookmarks.length) {
      await sleep(1000);
    }
  }

  const relevant = [...results.values()].filter((r) => r.relevant).length;
  logger.info(
    `Classification complete: ${relevant}/${bookmarks.length} relevant`
  );

  return results;
}

// --- Step 1c: Thread Expansion ---

async function expandThreads(
  bookmarks: BookmarkRaw[]
): Promise<Map<string, string>> {
  const candidates = bookmarks.filter((b) => b.conversationId && b.authorId);
  logger.info(
    `Step 1c: Expanding threads for ${candidates.length} bookmarks with conversation IDs...`
  );

  const client = await getTwitterClient();
  const threads = new Map<string, string>();
  let expanded = 0;

  for (let i = 0; i < candidates.length; i++) {
    const bookmark = candidates[i];
    try {
      const threadContent = await fetchThreadContent(
        client,
        bookmark.conversationId!,
        bookmark.authorId!
      );
      if (threadContent) {
        threads.set(bookmark.id, threadContent);
        expanded++;
      }
    } catch {
      logger.debug(`Thread expansion failed for ${bookmark.id}`);
    }

    // Rate limiting: Twitter search API is 180 req/15 min
    await sleep(1000);

    if ((i + 1) % 50 === 0) {
      logger.info(
        `Thread progress: ${i + 1}/${candidates.length} checked, ${expanded} expanded`
      );
    }
  }

  logger.info(
    `Threads expanded: ${expanded}/${candidates.length} candidates`
  );
  return threads;
}

// --- Step 1d: Article Extraction ---

async function extractAllArticles(bookmarks: BookmarkRaw[]) {
  const allUrls = bookmarks.flatMap((b) => b.urls);
  const uniqueUrls = [...new Set(allUrls)];

  logger.info(
    `Step 1d: Extracting articles from ${uniqueUrls.length} unique URLs...`
  );

  const result = await extractArticles(uniqueUrls);

  logger.info(
    `Articles extracted: ${result.stats.articlesExtracted}, failed: ${result.stats.failedExtractions}`
  );

  return result;
}

// --- Main Pipeline ---

async function main() {
  const startTime = Date.now();
  logger.info("=== CAIO Bookmark Export Pipeline ===");

  // Ensure output directory exists
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1a: Fetch all bookmarks
  const allBookmarks = await fetchAllBookmarks();

  if (allBookmarks.length === 0) {
    logger.warn("No bookmarks found. Exiting.");
    return;
  }

  // Step 1b: Classify
  const classifications = await classifyBookmarks(allBookmarks);

  // Filter to relevant bookmarks
  const relevantBookmarks = allBookmarks.filter((b) => {
    const c = classifications.get(b.id);
    return c?.relevant !== false; // Include if relevant or if classification missing
  });

  const excludedCount = allBookmarks.length - relevantBookmarks.length;
  logger.info(
    `Relevant: ${relevantBookmarks.length}, Excluded: ${excludedCount}`
  );

  // Step 1c: Expand threads (only for relevant bookmarks)
  const threads = await expandThreads(relevantBookmarks);

  // Step 1d: Extract articles (only for relevant bookmarks)
  const { articles, stats: articleStats } =
    await extractAllArticles(relevantBookmarks);

  // Step 1e: Assemble and save
  logger.info("Step 1e: Assembling enriched output...");

  const dates = allBookmarks.map((b) => new Date(b.createdAt).getTime());
  const oldest = new Date(Math.min(...dates)).toISOString().split("T")[0];
  const newest = new Date(Math.max(...dates)).toISOString().split("T")[0];

  const enrichedBookmarks: EnrichedBookmark[] = relevantBookmarks.map((b) => {
    const classification = classifications.get(b.id)!;
    const threadContent = threads.get(b.id);

    // Match articles to this bookmark's URLs
    const bookmarkArticles = b.urls
      .map((url) => {
        const article = articles.get(url);
        if (!article) return null;
        return {
          url: article.url,
          title: article.title,
          content: article.content.slice(0, 8000),
          author: article.author,
          siteName: article.siteName,
        };
      })
      .filter(
        (a): a is NonNullable<typeof a> => a !== null
      );

    return {
      id: b.id,
      text: b.text,
      authorName: b.authorName,
      authorUsername: b.authorUsername,
      createdAt: b.createdAt,
      urls: b.urls,
      relevanceScore: classification.relevanceScore,
      whyRelevant: classification.whyRelevant,
      themeHints: classification.themeHints,
      threadContent,
      articles: bookmarkArticles,
    };
  });

  const output: ExportOutput = {
    exportedAt: new Date().toISOString(),
    stats: {
      totalFetched: allBookmarks.length,
      relevant: relevantBookmarks.length,
      excluded: excludedCount,
      threadsExpanded: threads.size,
      articlesExtracted: articleStats.articlesExtracted,
      articlesFailed: articleStats.failedExtractions,
      youtubeTranscripts: articleStats.youtubeWithTranscript,
    },
    dateRange: { oldest, newest },
    bookmarks: enrichedBookmarks,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  logger.info("=== Export complete ===");
  logger.info(`Output: ${OUTPUT_FILE}`);
  logger.info(`Stats: ${JSON.stringify(output.stats, null, 2)}`);
  logger.info(`Time: ${elapsed} minutes`);
}

main().catch((error) => {
  logger.error("Export pipeline failed:", error);
  process.exit(1);
});
