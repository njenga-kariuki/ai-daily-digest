import { createLogger } from "../utils/logger.js";
import type { ExtractedArticle } from "./types.js";

const logger = createLogger("GitHubExtractor");

interface GitHubRepoInfo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  topics: string[];
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
  };
}

interface GitHubReadmeInfo {
  content: string;
  encoding: string;
}

// Rate limiting: track API calls per digest run
let apiCallCount = 0;
const MAX_API_CALLS = 10;

export function resetGitHubApiCounter(): void {
  apiCallCount = 0;
}

function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes("github.com")) {
      return null;
    }

    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }

    return {
      owner: pathParts[0],
      repo: pathParts[1].replace(/\.git$/, ""),
    };
  } catch {
    return null;
  }
}

async function fetchWithRetry(
  url: string,
  retries = 3
): Promise<Response | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "AI-Daily-Digest/1.0",
        },
      });

      if (response.ok) {
        return response;
      }

      if (response.status === 404) {
        return null; // Don't retry 404s
      }

      if (response.status === 403) {
        logger.debug("GitHub API rate limit may be reached");
        return null;
      }
    } catch (error) {
      if (attempt === retries - 1) {
        logger.debug(`Failed to fetch ${url}`, error);
      }
    }

    // Exponential backoff
    if (attempt < retries - 1) {
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  return null;
}

export async function extractGitHubContent(
  url: string
): Promise<ExtractedArticle | null> {
  if (apiCallCount >= MAX_API_CALLS) {
    logger.debug(`Skipping GitHub URL (rate limit reached): ${url}`);
    return null;
  }

  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return null;
  }

  const { owner, repo } = parsed;
  logger.debug(`Extracting GitHub repo: ${owner}/${repo}`);

  try {
    // Fetch repo info
    apiCallCount++;
    const repoResponse = await fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}`
    );

    if (!repoResponse) {
      return null;
    }

    const repoInfo: GitHubRepoInfo = await repoResponse.json();

    // Fetch README
    let readmeContent = "";
    apiCallCount++;
    const readmeResponse = await fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/readme`
    );

    if (readmeResponse) {
      const readmeInfo: GitHubReadmeInfo = await readmeResponse.json();
      if (readmeInfo.content && readmeInfo.encoding === "base64") {
        const decoded = Buffer.from(readmeInfo.content, "base64").toString("utf-8");
        // Take first 2000 chars of README
        readmeContent = decoded.substring(0, 2000);
        if (decoded.length > 2000) {
          readmeContent += "\n\n[README truncated...]";
        }
      }
    }

    // Build content
    const contentParts: string[] = [];

    if (repoInfo.description) {
      contentParts.push(`Description: ${repoInfo.description}`);
    }

    if (repoInfo.language) {
      contentParts.push(`Primary Language: ${repoInfo.language}`);
    }

    if (repoInfo.topics && repoInfo.topics.length > 0) {
      contentParts.push(`Topics: ${repoInfo.topics.join(", ")}`);
    }

    contentParts.push(`Stars: ${repoInfo.stargazers_count.toLocaleString()}`);

    if (readmeContent) {
      contentParts.push(`\n--- README Preview ---\n${readmeContent}`);
    }

    const content = contentParts.join("\n");

    return {
      url,
      title: `${repoInfo.full_name} - GitHub Repository`,
      content,
      author: repoInfo.owner.login,
      siteName: "GitHub",
    };
  } catch (error) {
    logger.debug(`Failed to extract GitHub content: ${url}`, error);
    return null;
  }
}

export function isGitHubUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes("github.com");
  } catch {
    return false;
  }
}
