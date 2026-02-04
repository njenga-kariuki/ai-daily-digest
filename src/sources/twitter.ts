import { TwitterApi } from "twitter-api-v2";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import { sourcesConfig } from "../config/settings.js";
import type { TwitterBookmark } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("Twitter");
const TOKEN_PATH = join(__dirname, "../../twitter-token.json");
const CALLBACK_URL = "http://localhost";

interface TwitterTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  createdAt?: string;
  clientId: string;
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s]+/g;
  const matches = text.match(urlRegex) || [];
  // Filter out Twitter's own URLs
  return matches.filter(
    (url) => !url.includes("twitter.com") && !url.includes("x.com")
  );
}

function loadTokens(): TwitterTokens | null {
  if (!existsSync(TOKEN_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveTokens(tokens: TwitterTokens): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(tokens: TwitterTokens): Promise<TwitterTokens> {
  if (!tokens.refreshToken) {
    throw new Error("No refresh token available");
  }

  const client = new TwitterApi({ clientId: tokens.clientId });
  const { accessToken, refreshToken, expiresIn } = await client.refreshOAuth2Token(
    tokens.refreshToken
  );

  const newTokens: TwitterTokens = {
    accessToken,
    refreshToken,
    expiresIn,
    createdAt: new Date().toISOString(),
    clientId: tokens.clientId,
  };

  saveTokens(newTokens);
  logger.info("Twitter access token refreshed");
  return newTokens;
}

async function getTwitterClient(): Promise<TwitterApi> {
  let tokens = loadTokens();

  if (!tokens) {
    throw new Error(
      "Twitter OAuth 2.0 tokens not found. Run 'npm run twitter-auth' to authenticate."
    );
  }

  // Check if token might be expired (if we have expiry info)
  if (tokens.createdAt && tokens.expiresIn) {
    const createdAt = new Date(tokens.createdAt).getTime();
    const expiresAt = createdAt + tokens.expiresIn * 1000;
    const now = Date.now();

    // Refresh if token expires in less than 5 minutes
    if (now > expiresAt - 5 * 60 * 1000) {
      try {
        tokens = await refreshAccessToken(tokens);
      } catch (error) {
        logger.warn("Failed to refresh token, trying with existing token");
      }
    }
  }

  return new TwitterApi(tokens.accessToken);
}

interface TweetData {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  entities?: {
    urls?: Array<{
      expanded_url?: string;
    }>;
  };
}

async function fetchThreadContent(
  client: TwitterApi,
  conversationId: string,
  authorId: string
): Promise<string | undefined> {
  try {
    // Search for tweets in this conversation from the same author
    const searchResult = await client.v2.search(
      `conversation_id:${conversationId} from:${authorId}`,
      {
        max_results: 100,
        "tweet.fields": ["created_at", "author_id"],
        sort_order: "recency",
      }
    );

    const tweets = searchResult.data?.data || [];

    if (tweets.length <= 1) {
      return undefined; // Not a thread (just the original tweet)
    }

    // Sort by created_at ascending (oldest first) for chronological order
    const sortedTweets = tweets.sort((a, b) => {
      const dateA = new Date(a.created_at || 0).getTime();
      const dateB = new Date(b.created_at || 0).getTime();
      return dateA - dateB;
    });

    // Combine tweet texts
    const threadText = sortedTweets.map((t) => t.text).join("\n\n---\n\n");

    logger.debug(
      `Fetched thread with ${sortedTweets.length} tweets for conversation ${conversationId}`
    );

    return threadText;
  } catch (error) {
    logger.debug(
      `Failed to fetch thread for conversation ${conversationId}:`,
      error
    );
    return undefined;
  }
}

export interface TwitterFetchResult {
  bookmarks: TwitterBookmark[];
  threadsExpanded: number;
}

export async function fetchBookmarks(): Promise<TwitterFetchResult> {
  logger.info("Fetching bookmarks from Twitter");

  const client = await getTwitterClient();
  const { lookbackHours, maxBookmarks } = sourcesConfig.twitter;

  const cutoffTime = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  try {
    // Get authenticated user's ID
    const me = await client.v2.me();
    const userId = me.data.id;

    // Fetch bookmarks
    const bookmarks = await client.v2.bookmarks({
      max_results: Math.min(maxBookmarks, 100),
      expansions: ["author_id"],
      "tweet.fields": ["created_at", "entities", "text", "conversation_id"],
      "user.fields": ["name", "username"],
    });

    const results: TwitterBookmark[] = [];
    const users = new Map(
      (bookmarks.includes?.users || []).map((u) => [u.id, u])
    );

    // First pass: collect all bookmarks
    const bookmarkData: Array<{
      tweet: TweetData;
      author: { name: string; username: string } | undefined;
    }> = [];

    for (const tweet of (bookmarks.data.data || []) as TweetData[]) {
      const createdAt = new Date(tweet.created_at || Date.now());

      // Skip tweets older than lookback period
      if (createdAt < cutoffTime) {
        continue;
      }

      const author = users.get(tweet.author_id || "");
      bookmarkData.push({ tweet, author });
    }

    logger.info(`Processing ${bookmarkData.length} bookmarks within lookback period`);

    // Second pass: fetch thread content for threaded tweets
    for (const { tweet, author } of bookmarkData) {
      const createdAt = new Date(tweet.created_at || Date.now());

      // Extract URLs from entities and text
      const urls: string[] = [];
      if (tweet.entities?.urls) {
        for (const urlEntity of tweet.entities.urls) {
          if (urlEntity.expanded_url) {
            urls.push(urlEntity.expanded_url);
          }
        }
      }
      // Also extract from text in case entities missed any
      urls.push(...extractUrls(tweet.text));
      const uniqueUrls = [...new Set(urls)].filter(
        (url) => !url.includes("twitter.com") && !url.includes("x.com")
      );

      // Check if this is a thread and fetch thread content
      let threadContent: string | undefined;
      if (tweet.conversation_id && tweet.author_id) {
        // Only fetch thread if the tweet is part of a conversation
        // and we have the author's ID to filter
        threadContent = await fetchThreadContent(
          client,
          tweet.conversation_id,
          tweet.author_id
        );
      }

      results.push({
        id: tweet.id,
        text: tweet.text,
        authorName: author?.name || "Unknown",
        authorUsername: author?.username || "unknown",
        authorId: tweet.author_id,
        createdAt,
        urls: uniqueUrls,
        conversationId: tweet.conversation_id,
        threadContent,
      });
    }

    const threadsExpanded = results.filter((r) => r.threadContent).length;
    logger.info(
      `Fetched ${results.length} bookmarks from last ${lookbackHours}h (${threadsExpanded} threads expanded)`
    );
    return { bookmarks: results, threadsExpanded };
  } catch (error: any) {
    if (error.code === 403) {
      logger.error(
        "Twitter API access forbidden. Ensure OAuth 2.0 is set up correctly with bookmark.read scope."
      );
    } else if (error.code === 401) {
      logger.error(
        "Twitter API unauthorized. Token may be expired. Try running 'npm run twitter-auth' again."
      );
    }
    throw error;
  }
}
