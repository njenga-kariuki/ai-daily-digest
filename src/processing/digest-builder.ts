import { createLogger } from "../utils/logger.js";
import { generateExecutiveSummary } from "./summarizer.js";
import type {
  Digest,
  DigestSection,
  SummarizedItem,
} from "../sources/types.js";

const logger = createLogger("DigestBuilder");

function generateDigestId(): string {
  const now = new Date();
  return `digest-${now.toISOString().split("T")[0]}-${now.getTime()}`;
}

function groupByTopic(items: SummarizedItem[]): Map<string, SummarizedItem[]> {
  const groups = new Map<string, SummarizedItem[]>();

  for (const item of items) {
    // Use the primary (first) topic for grouping
    const primaryTopic = item.topics[0] || "Uncategorized";

    if (!groups.has(primaryTopic)) {
      groups.set(primaryTopic, []);
    }
    groups.get(primaryTopic)!.push(item);
  }

  return groups;
}

function rankItems(items: SummarizedItem[]): SummarizedItem[] {
  return [...items].sort((a, b) => {
    // Primary sort by AI relevance score (descending)
    if (b.aiRelevanceScore !== a.aiRelevanceScore) {
      return b.aiRelevanceScore - a.aiRelevanceScore;
    }
    // Secondary sort by recency
    return b.publishedAt.getTime() - a.publishedAt.getTime();
  });
}

export async function buildDigest(
  items: SummarizedItem[],
  sourceStats: {
    twitterCount: number;
    gmailCount: number;
    articlesExtracted: number;
    failedExtractions: number;
  },
  errors: string[] = []
): Promise<Digest> {
  logger.info(`Building digest from ${items.length} summarized items`);

  // Filter to AI-relevant items (score > 0.3)
  const relevantItems = items.filter((item) => item.aiRelevanceScore > 0.3);
  logger.info(`${relevantItems.length} items passed AI relevance filter`);

  // Rank all items
  const rankedItems = rankItems(relevantItems);

  // Get top 5 stories
  const topStories = rankedItems.slice(0, 5);

  // Group remaining items by topic
  const topicGroups = groupByTopic(rankedItems);

  // Build sections, ordered by aggregate relevance
  const sections: DigestSection[] = [];
  const sectionScores: [string, number][] = [];

  for (const [topic, topicItems] of topicGroups) {
    const avgScore =
      topicItems.reduce((sum, item) => sum + item.aiRelevanceScore, 0) /
      topicItems.length;
    sectionScores.push([topic, avgScore]);
  }

  sectionScores.sort((a, b) => b[1] - a[1]);

  for (const [topic] of sectionScores) {
    const topicItems = topicGroups.get(topic)!;
    sections.push({
      topic,
      items: rankItems(topicItems),
    });
  }

  // Generate executive summary
  let executiveSummary: string;
  if (rankedItems.length > 0) {
    executiveSummary = await generateExecutiveSummary(rankedItems);
  } else {
    executiveSummary =
      "No AI-relevant content was found in today's sources. Check your bookmark folders and newsletter labels.";
  }

  const digest: Digest = {
    id: generateDigestId(),
    generatedAt: new Date(),
    executiveSummary,
    topStories,
    sections,
    sourceStats,
    errors,
  };

  logger.info(`Digest built: ${digest.id}`);
  return digest;
}
