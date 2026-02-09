import { createLogger } from "../utils/logger.js";
import type { ExtractedArticle } from "./types.js";

const logger = createLogger("PuppeteerFallback");

// Known JS-heavy sites where regular extraction often fails
const JS_HEAVY_DOMAINS = [
  "medium.com",
  "dev.to",
  "substack.com",
  "notion.so",
  "hashnode.dev",
  "mirror.xyz",
  "beehiiv.com",
];

// Simple cache to avoid re-rendering same URLs
const renderCache = new Map<string, ExtractedArticle | null>();

export function isJsHeavySite(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return JS_HEAVY_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

export function getCachedResult(url: string): ExtractedArticle | null | undefined {
  return renderCache.get(url);
}

export function hasCachedResult(url: string): boolean {
  return renderCache.has(url);
}

const PUPPETEER_TIMEOUT_MS = 30_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

async function forceKillBrowser(browser: any): Promise<void> {
  try {
    const browserProcess = browser.process();
    if (browserProcess) {
      browserProcess.kill("SIGKILL");
    }
  } catch {
    // Ignore — best effort
  }
}

async function closeBrowserSafely(browser: any): Promise<void> {
  try {
    await Promise.race([
      browser.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("browser.close() timeout")), BROWSER_CLOSE_TIMEOUT_MS)
      ),
    ]);
  } catch {
    // browser.close() hung or failed — force kill the process
    logger.debug("browser.close() timed out — force killing browser process");
    await forceKillBrowser(browser);
  }
}

async function extractWithPuppeteerInner(
  url: string
): Promise<ExtractedArticle | null> {
  let browser = null;

  try {
    // Dynamic import to avoid loading Puppeteer when not needed
    const puppeteer = await import("puppeteer");

    browser = await puppeteer.default.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Set viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate with timeout
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 10000,
    });

    // Wait a bit for JS to render
    await new Promise((r) => setTimeout(r, 2000));

    // Extract content
    const data = await page.evaluate(() => {
      // Try to find the main content
      const selectors = [
        "article",
        '[role="article"]',
        ".post-content",
        ".article-content",
        ".entry-content",
        "main",
        ".content",
      ];

      let contentElement: Element | null = null;
      for (const selector of selectors) {
        contentElement = document.querySelector(selector);
        if (contentElement) break;
      }

      if (!contentElement) {
        contentElement = document.body;
      }

      // Get text content
      const content = contentElement.textContent || "";

      // Get title
      const titleElement =
        document.querySelector("h1") ||
        document.querySelector("title") ||
        document.querySelector('[property="og:title"]');

      let title = "";
      if (titleElement) {
        title = titleElement.textContent ||
          (titleElement as unknown as HTMLMetaElement).content || "";
      }

      // Get author
      const authorElement =
        document.querySelector('[rel="author"]') ||
        document.querySelector(".author") ||
        document.querySelector('[property="article:author"]');

      let author = "";
      if (authorElement) {
        author = authorElement.textContent ||
          (authorElement as unknown as HTMLMetaElement).content || "";
      }

      return { title, content, author };
    });

    await closeBrowserSafely(browser);
    browser = null;

    // Clean up content
    const cleanContent = data.content
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 50000);

    if (cleanContent.length < 200) {
      renderCache.set(url, null);
      return null;
    }

    const result: ExtractedArticle = {
      url,
      title: data.title.trim() || "Untitled",
      content: cleanContent,
      author: data.author.trim() || undefined,
      siteName: new URL(url).hostname,
    };

    renderCache.set(url, result);
    return result;
  } catch (error) {
    logger.debug(`Puppeteer extraction failed for: ${url}`, error);
    renderCache.set(url, null);
    return null;
  } finally {
    if (browser) {
      await closeBrowserSafely(browser);
    }
  }
}

export async function extractWithPuppeteer(
  url: string
): Promise<ExtractedArticle | null> {
  // Check cache first
  if (renderCache.has(url)) {
    return renderCache.get(url) || null;
  }

  logger.debug(`Puppeteer fallback for: ${url}`);

  return Promise.race([
    extractWithPuppeteerInner(url),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        logger.warn(`Puppeteer timeout (${PUPPETEER_TIMEOUT_MS / 1000}s) for: ${url}`);
        renderCache.set(url, null);
        resolve(null);
      }, PUPPETEER_TIMEOUT_MS)
    ),
  ]);
}

export function clearPuppeteerCache(): void {
  renderCache.clear();
}
