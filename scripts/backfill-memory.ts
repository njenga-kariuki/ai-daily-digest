import { sourcesConfig } from "../src/config/settings.js";
import { buildMemoryArtifacts } from "../src/processing/memory-builder.js";
import { getDigestHistory } from "../src/storage/digest-store.js";
import { SqliteMemoryProvider } from "../src/storage/memory-store.js";
import type {
  Digest,
  SummarizedItem,
  SynthesizedTheme,
} from "../src/sources/types.js";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("BackfillMemory");

type LegacyDigest = Record<string, unknown>;

function asDate(value: unknown, fallback: Date): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v)
  );
}

function normalizeItemDates(item: SummarizedItem): SummarizedItem {
  return {
    ...item,
    publishedAt:
      item.publishedAt instanceof Date
        ? item.publishedAt
        : new Date(item.publishedAt),
    extractedAt:
      item.extractedAt instanceof Date
        ? item.extractedAt
        : new Date(item.extractedAt),
  };
}

function normalizeLegacyItem(
  input: Record<string, unknown>,
  digestId: string,
  generatedAt: Date,
  fallbackIndex: number
): SummarizedItem {
  const id = asString(input.id, `${digestId}:legacy:${fallbackIndex}`);
  const source = input.source === "gmail" ? "gmail" : "twitter";
  const title = asString(input.title, "Untitled");
  const content = asString(input.content, asString(input.summary, ""));
  const summary = asString(
    input.summary,
    content.length > 0 ? `${content.slice(0, 220)}...` : "No summary available"
  );

  return {
    id,
    source,
    title,
    content,
    url: asString(input.url) || undefined,
    author: asString(input.author) || undefined,
    publishedAt: asDate(input.publishedAt, generatedAt),
    extractedAt: asDate(input.extractedAt, generatedAt),
    twitterSourceType:
      input.twitterSourceType === "account" || input.twitterSourceType === "bookmark"
        ? input.twitterSourceType
        : undefined,
    sourceAccount: asString(input.sourceAccount) || undefined,
    parentNewsletterId: asString(input.parentNewsletterId) || undefined,
    newsletterName: asString(input.newsletterName) || undefined,
    summary,
    keyTakeaways: asStringArray(input.keyTakeaways),
    aiRelevanceScore:
      typeof input.aiRelevanceScore === "number"
        ? input.aiRelevanceScore
        : 0.5,
    topics: asStringArray(input.topics).length
      ? asStringArray(input.topics)
      : ["Uncategorized"],
  };
}

function normalizeTheme(input: Record<string, unknown>): SynthesizedTheme {
  const contributingSources = asObjectArray(input.contributingSources).map(
    (source) => ({
      title: asString(source.title, asString(source.snippet, "Source")),
      author: asString(source.author, "unknown"),
      sourceType: asString(source.sourceType, "account"),
      snippet: asString(source.snippet, ""),
      url: asString(source.url) || undefined,
    })
  );

  return {
    theme: asString(input.theme, "Theme"),
    narrative: asString(input.narrative, asString(input.summary, "")),
    keyInsights: asStringArray(input.keyInsights).length
      ? asStringArray(input.keyInsights)
      : asStringArray(input.keyPoints),
    sources: contributingSources,
  };
}

function collectLegacyItems(digest: LegacyDigest, digestId: string, generatedAt: Date): SummarizedItem[] {
  const topStories = asObjectArray(digest.topStories);
  const sectionItems = asObjectArray(digest.sections).flatMap((section) =>
    asObjectArray(section.items)
  );
  const candidates = [...topStories, ...sectionItems];

  const normalized = candidates.map((item, idx) =>
    normalizeLegacyItem(item, digestId, generatedAt, idx)
  );

  const seen = new Set<string>();
  return normalized.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function normalizeDigest(digest: Digest | LegacyDigest): Digest {
  const digestObj = digest as LegacyDigest;
  const generatedAt = asDate(digestObj.generatedAt, new Date());
  const digestId = asString(
    digestObj.id,
    `legacy-${generatedAt.toISOString()}`
  );

  const allItemsRaw = asObjectArray(digestObj.allItems);
  const allItems =
    allItemsRaw.length > 0
      ? allItemsRaw.map((item, idx) =>
          normalizeLegacyItem(item, digestId, generatedAt, idx)
        )
      : collectLegacyItems(digestObj, digestId, generatedAt);

  const themesRaw = asObjectArray(digestObj.themes);
  const accountThemesRaw = asObjectArray(digestObj.accountThemes);
  const themes =
    themesRaw.length > 0
      ? themesRaw.map(normalizeTheme)
      : accountThemesRaw.map(normalizeTheme);

  return {
    id: digestId,
    generatedAt,
    executiveBrief:
      typeof digestObj.executiveBrief === "object" && digestObj.executiveBrief !== null
        ? (digestObj.executiveBrief as Digest["executiveBrief"])
        : undefined,
    themes,
    allItems: allItems.map(normalizeItemDates),
    sourceStats:
      typeof digestObj.sourceStats === "object" && digestObj.sourceStats !== null
        ? (digestObj.sourceStats as Digest["sourceStats"])
        : {
            twitterCount: 0,
            gmailCount: 0,
            articlesExtracted: 0,
            failedExtractions: 0,
          },
    errors: asStringArray(digestObj.errors),
  };
}

async function main(): Promise<void> {
  const provider = new SqliteMemoryProvider();
  await provider.init();

  const history = getDigestHistory();
  const digests = history.digests
    .map(normalizeDigest)
    .sort((a, b) => a.generatedAt.getTime() - b.generatedAt.getTime());

  let totalCards = 0;
  let totalMerged = 0;

  logger.info(`Backfilling memory from ${digests.length} historical digests`);

  for (const digest of digests) {
    const artifacts = buildMemoryArtifacts(digest);
    const result = await provider.ingest(artifacts.cards, artifacts.links, {
      runDate: new Date(),
      retrievalMs: 0,
      cardsUsed: 0,
      tokenOverheadEstimate: 0,
      notes: `backfill:${digest.id}`,
    });

    totalCards += result.cardsCreated;
    totalMerged += result.cardsMerged;
    logger.info(
      `Backfilled ${digest.id}: created=${result.cardsCreated}, merged=${result.cardsMerged}`
    );
  }

  if (sourcesConfig.processing.memory.compaction.enabled) {
    await provider.compact(new Date());
  }

  logger.info(
    `Backfill complete: created=${totalCards}, merged=${totalMerged}, digests=${digests.length}`
  );
}

main().catch((error) => {
  logger.error("Backfill failed", error);
  process.exit(1);
});
