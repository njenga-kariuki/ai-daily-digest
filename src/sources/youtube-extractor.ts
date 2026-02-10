import {
  fetchTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript-plus";
import { createLogger } from "../utils/logger.js";
import type { ExtractedArticle } from "./types.js";

const logger = createLogger("YouTubeExtractor");

interface VideoMetadata {
  title: string;
  author_name: string;
  thumbnail_url: string;
}

interface TranscriptSegment {
  text: string;
  offset: number;
  duration: number;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function parseVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    if (hostname.includes("youtube.com")) {
      const videoId = urlObj.searchParams.get("v");
      if (videoId) return videoId;

      const pathParts = urlObj.pathname.split("/").filter(Boolean);
      if (pathParts[0] === "shorts" && pathParts[1]) {
        return pathParts[1];
      }
    }

    if (hostname.includes("youtu.be")) {
      const pathParts = urlObj.pathname.split("/").filter(Boolean);
      if (pathParts[0]) {
        return pathParts[0].split("?")[0];
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function fetchVideoMetadata(
  videoId: string
): Promise<VideoMetadata | null> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    logger.debug(`Failed to fetch video metadata for ${videoId}`, error);
    return null;
  }
}

async function fetchTranscriptWithRetry(
  videoId: string,
  retries = 2
): Promise<TranscriptSegment[] | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const segments = await Promise.race([
        fetchTranscript(videoId, {
          userAgent: getRandomUserAgent(),
          lang: "en",
        }),
        new Promise<null>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(null), 10_000);
        }),
      ]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (segments && segments.length > 0) {
        return segments;
      }
    } catch (error) {
      if (
        error instanceof YoutubeTranscriptDisabledError ||
        error instanceof YoutubeTranscriptNotAvailableError ||
        error instanceof YoutubeTranscriptVideoUnavailableError
      ) {
        // These are expected failures - no transcript available
        logger.debug(
          `Transcript not available for ${videoId}: ${error.message}`
        );
        return null;
      }

      if (attempt < retries) {
        logger.debug(
          `Transcript fetch attempt ${attempt + 1} failed for ${videoId}, retrying...`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        logger.debug(`All transcript fetch attempts failed for ${videoId}`, error);
      }
    }
  }
  return null;
}

function combineTranscriptSegments(segments: TranscriptSegment[]): string {
  // Combine segments into readable paragraphs
  // Group by rough time intervals (every ~30 seconds) to create natural breaks
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];
  let lastOffset = 0;

  for (const segment of segments) {
    // Start new paragraph after 30+ seconds gap or every ~2 minutes
    if (
      segment.offset - lastOffset > 30000 ||
      currentParagraph.join(" ").length > 1000
    ) {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(" "));
        currentParagraph = [];
      }
    }

    currentParagraph.push(segment.text.trim());
    lastOffset = segment.offset;
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(" "));
  }

  return paragraphs.join("\n\n");
}

export async function extractYouTubeContent(
  url: string
): Promise<ExtractedArticle | null> {
  const videoId = parseVideoId(url);

  if (!videoId) {
    logger.debug(`Could not parse video ID from: ${url}`);
    return null;
  }

  logger.debug(`Extracting YouTube video: ${videoId}`);

  // Fetch metadata and transcript in parallel
  const [metadata, transcriptSegments] = await Promise.all([
    fetchVideoMetadata(videoId),
    fetchTranscriptWithRetry(videoId),
  ]);

  if (!metadata) {
    logger.debug(`No metadata available for video: ${videoId}`);
    return null;
  }

  let content: string;
  let hasTranscript = false;

  if (transcriptSegments && transcriptSegments.length > 0) {
    const transcriptText = combineTranscriptSegments(transcriptSegments);
    content = `YouTube Video: ${metadata.title}\nChannel: ${metadata.author_name}\n\nTranscript:\n${transcriptText}`;
    hasTranscript = true;
    logger.info(
      `Extracted transcript for "${metadata.title}" (${transcriptSegments.length} segments)`
    );
  } else {
    // Fallback to metadata only
    content = `YouTube Video: ${metadata.title}\nChannel: ${metadata.author_name}\nURL: ${url}\n\n(No transcript available - summarize based on video title and context)`;
    logger.info(`Metadata only for "${metadata.title}" (no transcript available)`);
  }

  return {
    url,
    title: metadata.title,
    content,
    author: metadata.author_name,
    siteName: "YouTube",
    hasTranscript,
  };
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes("youtube.com") || hostname.includes("youtu.be");
  } catch {
    return false;
  }
}
