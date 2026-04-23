import { createLogger } from "../utils/logger.js";
import type {
  Digest,
  SummarizedItem,
  SynthesizedTheme,
  ExecutiveBrief,
} from "../sources/types.js";

const logger = createLogger("DigestBuilder");

function generateDigestId(): string {
  const now = new Date();
  return `digest-${now.toISOString().split("T")[0]}-${now.getTime()}`;
}

export function buildDigest(
  allItems: SummarizedItem[],
  themes: SynthesizedTheme[],
  executiveBrief: ExecutiveBrief | null,
  sourceStats: {
    twitterCount: number;
    gmailCount: number;
    rssCount?: number;
    webScoutCount?: number;
    articlesExtracted: number;
    failedExtractions: number;
    youtubeWithTranscript?: number;
    youtubeMetadataOnly?: number;
    threadsExpanded?: number;
  },
  errors: string[] = [],
  alsoNotable?: SummarizedItem[],
  options?: {
    crossConnections?: string[];
    footnotes?: SummarizedItem[];
  }
): Digest {
  logger.info(
    `Building digest from ${allItems.length} items and ${themes.length} themes`
  );

  const digest: Digest = {
    id: generateDigestId(),
    generatedAt: new Date(),
    executiveBrief: executiveBrief || undefined,
    themes,
    crossConnections: options?.crossConnections,
    allItems,
    alsoNotable,
    footnotes: options?.footnotes,
    sourceStats,
    errors,
  };

  logger.info(`Digest built: ${digest.id}`);
  return digest;
}
