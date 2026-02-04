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
  output: {
    recipientEmail: string;
    digestTime: string;
    timezone: string;
  };
  processing: {
    focusAreas: string[];
  };
}

function loadSourcesConfig(): SourcesConfig {
  const configPath = join(__dirname, "sources.json");
  const configData = readFileSync(configPath, "utf-8");
  return JSON.parse(configData) as SourcesConfig;
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
  },
  retry: {
    maxAttempts: 3,
    delayMs: 1000,
  },
};
