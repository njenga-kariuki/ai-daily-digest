import type {
  Digest,
  MemoryCard,
  MemoryEvidenceRef,
  MemoryLink,
  SummarizedItem,
  SynthesizedTheme,
} from "../sources/types.js";

export interface BuiltMemoryArtifacts {
  cards: MemoryCard[];
  links: MemoryLink[];
}

const ENTITY_HANDLE_REGEX = /@[a-zA-Z0-9_]{2,32}/g;
const ENTITY_CAPITALIZED_REGEX =
  /\b(?:[A-Z][a-zA-Z0-9-]{1,}|[A-Z]{2,})(?:\s+(?:[A-Z][a-zA-Z0-9-]{1,}|[A-Z]{2,})){0,3}\b/g;

function toDate(value: Date | string | undefined): Date {
  if (!value) return new Date();
  return value instanceof Date ? value : new Date(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 2);
}

function jaccardScore(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);

  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection++;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function evidenceUrlSet(card: MemoryCard): Set<string> {
  return new Set(
    card.evidenceRefs
      .map((e) => e.url?.trim().toLowerCase())
      .filter((u): u is string => Boolean(u))
  );
}

function urlOverlapScore(left: MemoryCard, right: MemoryCard): number {
  const a = evidenceUrlSet(left);
  const b = evidenceUrlSet(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const url of a) {
    if (b.has(url)) {
      overlap++;
    }
  }

  return overlap > 0 ? overlap / Math.max(a.size, b.size) : 0;
}

function titleSimilarity(left: MemoryCard, right: MemoryCard): number {
  return jaccardScore(tokenize(left.themeLabel), tokenize(right.themeLabel));
}

function entityOverlap(left: MemoryCard, right: MemoryCard): number {
  return jaccardScore(
    left.entities.map((e) => e.toLowerCase()),
    right.entities.map((e) => e.toLowerCase())
  );
}

export interface CardSimilarity {
  score: number;
  url: number;
  title: number;
  entity: number;
}

export function scoreCardSimilarity(
  incoming: MemoryCard,
  existing: MemoryCard
): CardSimilarity {
  const url = urlOverlapScore(incoming, existing);
  const title = titleSimilarity(incoming, existing);
  const entity = entityOverlap(incoming, existing);

  return {
    score: 0.5 * url + 0.25 * title + 0.25 * entity,
    url,
    title,
    entity,
  };
}

function uniqueEvidenceRefs(values: MemoryEvidenceRef[]): MemoryEvidenceRef[] {
  const seen = new Set<string>();
  const output: MemoryEvidenceRef[] = [];

  for (const value of values) {
    const key = `${value.itemId || ""}|${value.url || ""}|${value.title || ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }

  return output;
}

export function mergeCards(
  existing: MemoryCard,
  incoming: MemoryCard,
  newCardWeight = 0.6
): MemoryCard {
  const oldWeight = 1 - newCardWeight;
  const chooseIncomingSummary =
    incoming.confidenceScore >= existing.confidenceScore;

  return {
    ...existing,
    date: toDate(existing.date) < toDate(incoming.date) ? existing.date : incoming.date,
    themeLabel:
      incoming.importanceScore >= existing.importanceScore
        ? incoming.themeLabel
        : existing.themeLabel,
    summary: chooseIncomingSummary ? incoming.summary : existing.summary,
    entities: uniqueStrings([...existing.entities, ...incoming.entities]),
    tags: uniqueStrings([...existing.tags, ...incoming.tags]),
    evidenceRefs: uniqueEvidenceRefs([
      ...existing.evidenceRefs,
      ...incoming.evidenceRefs,
    ]),
    sourceTypes: uniqueStrings([...existing.sourceTypes, ...incoming.sourceTypes]),
    importanceScore: clamp01(
      existing.importanceScore * oldWeight + incoming.importanceScore * newCardWeight
    ),
    noveltyScore: clamp01(
      existing.noveltyScore * oldWeight + incoming.noveltyScore * newCardWeight
    ),
    confidenceScore: clamp01(
      existing.confidenceScore * oldWeight + incoming.confidenceScore * newCardWeight
    ),
    createdAt:
      toDate(existing.createdAt) <= toDate(incoming.createdAt)
        ? existing.createdAt
        : incoming.createdAt,
    updatedAt: incoming.updatedAt,
  };
}

function cardIdForTheme(digestId: string, index: number): string {
  return `${digestId}:theme:${index}`;
}

function cardIdForItem(digestId: string, item: SummarizedItem): string {
  return `${digestId}:item:${item.id}`;
}

function linkId(fromCardId: string, toCardId: string, linkType: MemoryLink["linkType"]): string {
  return `${linkType}:${fromCardId}->${toCardId}`;
}

export function extractEntitiesFromText(text: string): string[] {
  const handles = text.match(ENTITY_HANDLE_REGEX) || [];
  const capitalized = text.match(ENTITY_CAPITALIZED_REGEX) || [];

  return uniqueStrings(
    [...handles, ...capitalized]
      .map((s) => s.trim())
      .filter((s) => s.length >= 3 && s.length <= 80)
  ).slice(0, 24);
}

function itemRepresentedInThemes(item: SummarizedItem, themes: SynthesizedTheme[]): boolean {
  const normalizedTitle = item.title.trim().toLowerCase();
  const normalizedUrl = item.url?.trim().toLowerCase();

  return themes.some((theme) =>
    theme.sources.some((source) => {
      const sameTitle = source.title?.trim().toLowerCase() === normalizedTitle;
      const sameUrl =
        Boolean(normalizedUrl) &&
        source.url?.trim().toLowerCase() === normalizedUrl;
      return Boolean(sameTitle || sameUrl);
    })
  );
}

function buildThemeCard(
  digest: Digest,
  theme: SynthesizedTheme,
  index: number
): MemoryCard {
  const digestDate = toDate(digest.generatedAt);
  const keyInsightText = theme.keyInsights.join(" ");
  const sourceTypes = uniqueStrings(theme.sources.map((s) => s.sourceType));
  const evidenceRefs = uniqueEvidenceRefs(
    theme.sources.map((source) => ({
      title: source.title,
      url: source.url,
    }))
  );

  const entities = extractEntitiesFromText(
    `${theme.theme}\n${theme.narrative}\n${keyInsightText}`
  );

  const importance = clamp01(
    0.35 + Math.min(theme.sources.length, 8) * 0.08 + Math.min(theme.keyInsights.length, 8) * 0.04
  );
  const confidence = clamp01(
    0.3 + Math.min(theme.sources.length, 10) * 0.06 + (sourceTypes.length > 1 ? 0.1 : 0)
  );
  const novelty = clamp01(0.2 + Math.min(entities.length, 12) * 0.05);

  return {
    cardId: cardIdForTheme(digest.id, index),
    digestId: digest.id,
    date: digestDate,
    themeLabel: theme.theme,
    summary: `${theme.narrative}\n\nKey insights: ${theme.keyInsights.join("; ")}`.slice(
      0,
      2400
    ),
    entities,
    tags: uniqueStrings([
      theme.theme,
      ...theme.keyInsights.flatMap((insight) => insight.split(/[;,]/)),
    ]).slice(0, 24),
    evidenceRefs,
    sourceTypes,
    importanceScore: importance,
    noveltyScore: novelty,
    confidenceScore: confidence,
    createdAt: digestDate,
    updatedAt: digestDate,
  };
}

function buildItemCard(digest: Digest, item: SummarizedItem): MemoryCard {
  const digestDate = toDate(digest.generatedAt);
  const summaryText = `${item.summary}\n${item.keyTakeaways.join("; ")}`.slice(0, 2000);
  const entities = extractEntitiesFromText(
    `${item.title}\n${item.summary}\n${item.keyTakeaways.join(" ")}`
  );
  const sourceTypes = uniqueStrings([
    item.source,
    item.twitterSourceType || "",
  ]);

  const evidenceRefs = uniqueEvidenceRefs([
    {
      itemId: item.id,
      url: item.url,
      title: item.title,
    },
  ]);

  return {
    cardId: cardIdForItem(digest.id, item),
    digestId: digest.id,
    date: digestDate,
    themeLabel: item.topics[0] || "High-Signal Item",
    summary: summaryText,
    entities,
    tags: uniqueStrings(item.topics).slice(0, 24),
    evidenceRefs,
    sourceTypes,
    importanceScore: clamp01(0.3 + item.aiRelevanceScore * 0.6),
    noveltyScore: clamp01(0.25 + Math.min(entities.length, 10) * 0.04),
    confidenceScore: clamp01(0.35 + item.aiRelevanceScore * 0.55),
    createdAt: digestDate,
    updatedAt: digestDate,
  };
}

function maybeLinkItemToThemes(
  itemCard: MemoryCard,
  themeCards: MemoryCard[]
): MemoryLink[] {
  const links: MemoryLink[] = [];

  for (const themeCard of themeCards) {
    const similarity = scoreCardSimilarity(itemCard, themeCard).score;
    if (similarity >= 0.45 && similarity < 0.75) {
      links.push({
        linkId: linkId(themeCard.cardId, itemCard.cardId, "continuation"),
        fromCardId: themeCard.cardId,
        toCardId: itemCard.cardId,
        linkType: "continuation",
        strength: similarity,
        createdAt: itemCard.createdAt,
      });
    }
  }

  return links;
}

export const WATCH_LIST_FLAG_TAG = "watch-list-flag";

function cardIdForFlag(digestId: string, index: number): string {
  return `${digestId}:flag:${index}`;
}

function buildFlagCard(
  digest: Digest,
  flagText: string,
  index: number
): MemoryCard {
  const digestDate = toDate(digest.generatedAt);
  const entities = extractEntitiesFromText(flagText);
  const shortLabel = flagText.length > 80 ? `${flagText.slice(0, 77)}...` : flagText;

  return {
    cardId: cardIdForFlag(digest.id, index),
    digestId: digest.id,
    date: digestDate,
    themeLabel: `Flag: ${shortLabel}`,
    summary: `Watch-list flag from ${digestDate.toISOString().slice(0, 10)}: ${flagText}`,
    entities,
    tags: uniqueStrings([WATCH_LIST_FLAG_TAG, ...entities.slice(0, 6)]).slice(0, 24),
    evidenceRefs: [{ itemId: digest.id, title: digest.executiveBrief?.headline }],
    sourceTypes: ["executive-brief"],
    importanceScore: 0.7,
    noveltyScore: 0.55,
    confidenceScore: 0.6,
    createdAt: digestDate,
    updatedAt: digestDate,
  };
}

export function buildMemoryArtifacts(digest: Digest): BuiltMemoryArtifacts {
  const themeCards = digest.themes.map((theme, index) =>
    buildThemeCard(digest, theme, index)
  );

  const highSignalItems = digest.allItems.filter(
    (item) => item.aiRelevanceScore >= 0.8 && !itemRepresentedInThemes(item, digest.themes)
  );

  const itemCards = highSignalItems.map((item) => buildItemCard(digest, item));
  const links = itemCards.flatMap((itemCard) =>
    maybeLinkItemToThemes(itemCard, themeCards)
  );

  const watchList = digest.executiveBrief?.watchList || [];
  const flagCards = watchList
    .filter((flag) => typeof flag === "string" && flag.trim().length > 0)
    .map((flag, index) => buildFlagCard(digest, flag.trim(), index));

  return {
    cards: [...themeCards, ...itemCards, ...flagCards],
    links,
  };
}
