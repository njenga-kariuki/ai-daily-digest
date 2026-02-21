import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createLogger } from "../utils/logger.js";
import { settings } from "../config/settings.js";
import type { Digest } from "../sources/types.js";

const logger = createLogger("DigestStore");

interface ProcessedIds {
  twitter: string[];
  gmail: string[];
  articles: string[];
  rss: string[];
  "web-scout": string[];
  lastUpdated: string;
}

interface DigestHistory {
  digests: Digest[];
  lastUpdated: string;
}

function ensureDataDir(): void {
  if (!existsSync(settings.paths.dataDir)) {
    mkdirSync(settings.paths.dataDir, { recursive: true });
  }
}

function loadJson<T>(path: string, defaultValue: T): T {
  ensureDataDir();
  if (!existsSync(path)) {
    return defaultValue;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    logger.warn(`Failed to load ${path}, using default`, error);
    return defaultValue;
  }
}

function saveJson<T>(path: string, data: T): void {
  ensureDataDir();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// Processed IDs for deduplication
export function getProcessedIds(): ProcessedIds {
  const loaded = loadJson<ProcessedIds>(settings.paths.processedIds, {
    twitter: [],
    gmail: [],
    articles: [],
    rss: [],
    "web-scout": [],
    lastUpdated: new Date().toISOString(),
  });
  // Ensure new fields exist on old data files
  if (!loaded.rss) loaded.rss = [];
  if (!loaded["web-scout"]) loaded["web-scout"] = [];
  return loaded;
}

export function isProcessed(
  type: "twitter" | "gmail" | "articles" | "rss" | "web-scout",
  id: string
): boolean {
  const processed = getProcessedIds();
  return processed[type].includes(id);
}

export function markAsProcessed(
  type: "twitter" | "gmail" | "articles" | "rss" | "web-scout",
  ids: string[]
): void {
  const processed = getProcessedIds();

  // Add new IDs
  for (const id of ids) {
    if (!processed[type].includes(id)) {
      processed[type].push(id);
    }
  }

  // Keep only last 1000 IDs per type to prevent unbounded growth
  const maxIds = 1000;
  if (processed[type].length > maxIds) {
    processed[type] = processed[type].slice(-maxIds);
  }

  processed.lastUpdated = new Date().toISOString();
  saveJson(settings.paths.processedIds, processed);
  logger.debug(`Marked ${ids.length} ${type} items as processed`);
}

export function filterUnprocessed<T extends { id: string }>(
  type: "twitter" | "gmail" | "articles" | "rss" | "web-scout",
  items: T[]
): T[] {
  const processed = getProcessedIds();
  const processedSet = new Set(processed[type]);

  const unprocessed = items.filter((item) => !processedSet.has(item.id));
  logger.debug(
    `Filtered ${type}: ${items.length} total, ${unprocessed.length} unprocessed`
  );
  return unprocessed;
}

// Digest history
export function getDigestHistory(): DigestHistory {
  return loadJson<DigestHistory>(settings.paths.digestHistory, {
    digests: [],
    lastUpdated: new Date().toISOString(),
  });
}

export function saveDigest(digest: Digest): void {
  const history = getDigestHistory();

  // Add new digest at the beginning
  history.digests.unshift(digest);

  // Keep only last 30 digests
  if (history.digests.length > 30) {
    history.digests = history.digests.slice(0, 30);
  }

  history.lastUpdated = new Date().toISOString();
  saveJson(settings.paths.digestHistory, history);
  logger.info(`Saved digest: ${digest.id}`);
}

export function getLastDigest(): Digest | null {
  const history = getDigestHistory();
  return history.digests[0] || null;
}
