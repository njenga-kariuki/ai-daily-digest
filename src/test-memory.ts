import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import assert from "assert";
import {
  mergeCards,
  scoreCardSimilarity,
} from "./processing/memory-builder.js";
import { NoopMemoryProvider } from "./processing/memory-provider.js";
import { applyTokenBudget } from "./processing/memory-retriever.js";
import { SqliteMemoryProvider } from "./storage/memory-store.js";
import type { MemoryCard } from "./sources/types.js";
import { createLogger } from "./utils/logger.js";

const logger = createLogger("TestMemory");

function sampleCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  const now = new Date();
  return {
    cardId: overrides.cardId || "card-1",
    digestId: overrides.digestId || "digest-1",
    date: overrides.date || now,
    themeLabel: overrides.themeLabel || "Agentic AI",
    summary: overrides.summary || "AI agents are becoming productionized in enterprises.",
    entities: overrides.entities || ["OpenAI", "Anthropic", "Agentic AI"],
    tags: overrides.tags || ["agents", "enterprise"],
    evidenceRefs: overrides.evidenceRefs || [
      { url: "https://example.com/a", title: "Example A", itemId: "item-a" },
    ],
    sourceTypes: overrides.sourceTypes || ["twitter", "gmail"],
    importanceScore: overrides.importanceScore ?? 0.7,
    noveltyScore: overrides.noveltyScore ?? 0.5,
    confidenceScore: overrides.confidenceScore ?? 0.8,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
  };
}

async function testDedupeAndMerge(): Promise<void> {
  const a = sampleCard();
  const b = sampleCard({
    cardId: "card-2",
    summary: "Enterprise agent adoption is accelerating with stronger tooling.",
    entities: ["OpenAI", "Anthropic", "Enterprise Agent Adoption"],
  });

  const similarity = scoreCardSimilarity(b, a);
  assert(similarity.score >= 0.75, "Expected high similarity for near-duplicate cards");

  const merged = mergeCards(a, b);
  assert(merged.entities.includes("Enterprise Agent Adoption"), "Expected merged entities");
  assert(merged.evidenceRefs.length >= 1, "Expected merged evidence refs");
}

async function testTokenBudget(): Promise<void> {
  const cards = Array.from({ length: 12 }).map((_, idx) =>
    sampleCard({
      cardId: `card-${idx}`,
      summary: "x".repeat(500),
    })
  );

  const budgeted = applyTokenBudget(cards, 20, 300);
  assert(budgeted.cards.length < cards.length, "Expected token budgeting to trim cards");
  assert(budgeted.tokenEstimate <= 300, "Expected token estimate to stay in budget");
}

async function testRetrievalRankingAndFallback(): Promise<void> {
  const dbDir = mkdtempSync(join(tmpdir(), "digest-memory-test-"));
  const provider = new SqliteMemoryProvider(join(dbDir, "memory.db"));
  await provider.init();

  const now = new Date();
  const recentCard = sampleCard({
    cardId: "recent-card",
    date: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    themeLabel: "Model Release Velocity",
    summary: "Rapid model release cadence from major labs.",
    tags: ["llms", "releases"],
  });

  const oldCard = sampleCard({
    cardId: "old-card",
    date: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
    themeLabel: "AI Governance",
    summary: "Governance frameworks for customer-facing copilots.",
    tags: ["policy"],
    entities: ["Regulation", "Compliance"],
    evidenceRefs: [
      { url: "https://example.com/policy", title: "Policy Note", itemId: "item-p" },
    ],
  });

  await provider.ingest(
    [recentCard, oldCard],
    [],
    {
      runDate: now,
      retrievalMs: 0,
      cardsUsed: 0,
      tokenOverheadEstimate: 0,
      notes: "test-seed",
    }
  );

  const context = await provider.retrieve({
    now,
    activeWindowDays: 60,
    maxContextCards: 10,
    maxContextTokens: 800,
    topics: ["llms", "model release"],
    entities: ["OpenAI"],
    titles: ["Rapid model release cadence"],
  });

  assert(context.cards.length > 0, "Expected retrieval to return cards");
  assert(
    context.cards.some((card) => card.themeLabel === "Model Release Velocity"),
    "Expected retrieval to rank relevant card"
  );

  const noop = new NoopMemoryProvider("test");
  const noopContext = await noop.retrieve({
    now,
    activeWindowDays: 60,
    maxContextCards: 10,
    maxContextTokens: 800,
    topics: [],
    entities: [],
    titles: [],
  });
  assert(noopContext.cards.length === 0, "Expected noop provider to return empty context");
}

async function main(): Promise<void> {
  logger.info("Running memory tests...");
  await testDedupeAndMerge();
  await testTokenBudget();
  await testRetrievalRankingAndFallback();
  logger.info("Memory tests passed");
}

main().catch((error) => {
  logger.error("Memory tests failed", error);
  process.exit(1);
});
