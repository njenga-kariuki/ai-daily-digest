import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SourcesConfig {
  twitter: {
    bookmarkFolders: string[];
    lookbackHours: number;
    maxBookmarks: number;
    monitoredAccounts?: string[];
    accountSettings?: {
      maxTweetsPerAccount?: number;
      includeReplies?: boolean;
      includeRetweets?: boolean;
    };
  };
  gmail: {
    newsletterLabel: string;
    lookbackHours: number;
  };
  rss?: {
    enabled: boolean;
    lookbackHours: number;
    maxItemsPerFeed: number;
    feeds: Array<{
      name: string;
      url: string;
      category: string;
    }>;
  };
  webScout?: {
    enabled: boolean;
    searchProvider: string;
    maxQueriesPerRun: number;
    maxResultsPerQuery: number;
    queries: Array<{
      query: string;
      category: string;
    }>;
  };
  output: {
    recipientEmail: string;
    digestTime: string;
    timezone: string;
  };
  processing: {
    focusAreas: string[];
    memory: {
      enabled: boolean;
      activeWindowDays: number;
      maxContextCards: number;
      maxContextTokens: number;
      compaction: {
        enabled: boolean;
      };
    };
  };
}

function loadSourcesConfig(): SourcesConfig {
  const configPath = join(__dirname, "sources.json");
  const configData = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(configData) as Partial<SourcesConfig>;

  const memoryDefaults: SourcesConfig["processing"]["memory"] = {
    enabled: true,
    activeWindowDays: 60,
    maxContextCards: 20,
    maxContextTokens: 5000,
    compaction: {
      enabled: true,
    },
  };

  return {
    ...parsed,
    processing: {
      focusAreas: parsed.processing?.focusAreas || [],
      memory: {
        ...memoryDefaults,
        ...(parsed.processing?.memory || {}),
        compaction: {
          enabled:
            parsed.processing?.memory?.compaction?.enabled ??
            memoryDefaults.compaction.enabled,
        },
      },
    },
  } as SourcesConfig;
}

export const sourcesConfig = loadSourcesConfig();

export const settings = {
  claude: {
    model: "claude-sonnet-4-20250514",
    maxTokens: 4096,
  },
  rateLimit: {
    twitterRequestsPerMinute: 15,
    claudeRequestsPerMinute: 60,
  },
  paths: {
    dataDir: join(__dirname, "../../data"),
    digestHistory: join(__dirname, "../../data/digest-history.json"),
    processedIds: join(__dirname, "../../data/processed-ids.json"),
    memoryDb: join(__dirname, "../../data/memory.db"),
  },
  retry: {
    maxAttempts: 3,
    delayMs: 1000,
  },
};
