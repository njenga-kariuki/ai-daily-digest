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

export async function fetchBookmarks(): Promise<TwitterBookmark[]> {
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
      "tweet.fields": ["created_at", "entities", "text"],
      "user.fields": ["name", "username"],
    });

    const results: TwitterBookmark[] = [];
    const users = new Map(
      (bookmarks.includes?.users || []).map((u) => [u.id, u])
    );

    for (const tweet of bookmarks.data.data || []) {
      const createdAt = new Date(tweet.created_at || Date.now());

      // Skip tweets older than lookback period
      if (createdAt < cutoffTime) {
        continue;
      }

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
      // Also extract from text in case entities missed any
      urls.push(...extractUrls(tweet.text));
      const uniqueUrls = [...new Set(urls)].filter(
        (url) => !url.includes("twitter.com") && !url.includes("x.com")
      );

      results.push({
        id: tweet.id,
        text: tweet.text,
        authorName: author?.name || "Unknown",
        authorUsername: author?.username || "unknown",
        createdAt,
        urls: uniqueUrls,
      });
    }

    logger.info(`Fetched ${results.length} bookmarks from last ${lookbackHours}h`);
    return results;
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
