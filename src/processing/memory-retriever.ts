import type { SourcesConfig } from "../config/settings.js";
import type {
  HistoricalContextPack,
  MemoryCard,
  MemoryRetrievalQuery,
  SummarizedItem,
} from "../sources/types.js";
import { extractEntitiesFromText } from "./memory-builder.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function topByFrequency(values: string[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([value]) => value);
}

export function buildMemoryRetrievalQuery(
  allItems: SummarizedItem[],
  memoryConfig: SourcesConfig["processing"]["memory"]
): MemoryRetrievalQuery {
  const sortedByRelevance = [...allItems]
    .sort((a, b) => b.aiRelevanceScore - a.aiRelevanceScore)
    .slice(0, 8);

  const topics = topByFrequency(
    allItems.flatMap((item) => item.topics || []).map((t) => t.toLowerCase()),
    10
  );

  const entities = topByFrequency(
    uniqueStrings(
      allItems.flatMap((item) =>
        extractEntitiesFromText(`${item.title}\n${item.summary}\n${item.keyTakeaways.join(" ")}`)
      )
    ),
    16
  );

  const titles = sortedByRelevance.map((item) => item.title).slice(0, 8);

  return {
    now: new Date(),
    activeWindowDays: memoryConfig.activeWindowDays,
    maxContextCards: memoryConfig.maxContextCards,
    maxContextTokens: memoryConfig.maxContextTokens,
    topics,
    entities,
    titles,
  };
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatContextCard(card: MemoryCard): string {
  const refs = card.evidenceRefs
    .map((ref) => ref.title || ref.url || ref.itemId)
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");

  return [
    `Date: ${new Date(card.date).toISOString().slice(0, 10)}`,
    `Theme: ${card.themeLabel}`,
    `Summary: ${card.summary.slice(0, 500)}`,
    `Entities: ${card.entities.slice(0, 8).join(", ") || "none"}`,
    `Tags: ${card.tags.slice(0, 8).join(", ") || "none"}`,
    `Refs: ${refs || "none"}`,
    `Confidence: ${card.confidenceScore.toFixed(2)}`,
  ].join("\n");
}

export function applyTokenBudget(
  cards: MemoryCard[],
  maxCards: number,
  maxTokens: number
): { cards: MemoryCard[]; tokenEstimate: number } {
  const selected: MemoryCard[] = [];
  let runningTokens = 0;

  for (const card of cards) {
    if (selected.length >= maxCards) {
      break;
    }

    const cardTokens = estimateTokenCount(formatContextCard(card));
    if (runningTokens + cardTokens > maxTokens) {
      continue;
    }

    selected.push(card);
    runningTokens += cardTokens;
  }

  return {
    cards: selected,
    tokenEstimate: runningTokens,
  };
}

export function formatHistoricalContext(
  context: HistoricalContextPack | undefined
): string {
  if (!context || context.cards.length === 0) {
    return "(No relevant historical context retrieved)";
  }

  const cardsText = context.cards
    .map((card, index) => `[#${index + 1}]\n${formatContextCard(card)}`)
    .join("\n\n---\n\n");

  return [
    cardsText,
    "",
    `Confirmed threads: ${context.confirmedThreads.join("; ") || "none"}`,
    `Weak signals: ${context.weakSignals.join("; ") || "none"}`,
  ].join("\n");
}
