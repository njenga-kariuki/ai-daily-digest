import { execFile } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { promisify } from "util";
import { settings } from "../config/settings.js";
import {
  mergeCards,
  scoreCardSimilarity,
} from "../processing/memory-builder.js";
import { applyTokenBudget } from "../processing/memory-retriever.js";
import type {
  MemoryIngestMeta,
  MemoryProvider,
} from "../processing/memory-provider.js";
import type {
  HistoricalContextPack,
  MemoryCard,
  MemoryLink,
  MemoryRetrievalQuery,
  MemoryRunStats,
} from "../sources/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("MemoryStore");
const execFileAsync = promisify(execFile);

interface MemoryCardRow {
  card_id: string;
  digest_id: string;
  date: string;
  theme_label: string;
  summary: string;
  entities_json: string;
  tags_json: string;
  evidence_refs_json: string;
  source_types_json: string;
  importance_score: number;
  novelty_score: number;
  confidence_score: number;
  created_at: string;
  updated_at: string;
}

interface RankedCard {
  card: MemoryCard;
  finalScore: number;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function sqlArray(values: unknown[]): string {
  return sqlText(JSON.stringify(values));
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseEvidenceRefs(raw: string): MemoryCard["evidenceRefs"] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((v) => typeof v === "object" && v !== null)
      .map((v) => ({
        itemId: typeof v.itemId === "string" ? v.itemId : undefined,
        url: typeof v.url === "string" ? v.url : undefined,
        title: typeof v.title === "string" ? v.title : undefined,
      }));
  } catch {
    return [];
  }
}

function rowToCard(row: MemoryCardRow): MemoryCard {
  return {
    cardId: row.card_id,
    digestId: row.digest_id,
    date: new Date(row.date),
    themeLabel: row.theme_label,
    summary: row.summary,
    entities: parseStringArray(row.entities_json),
    tags: parseStringArray(row.tags_json),
    evidenceRefs: parseEvidenceRefs(row.evidence_refs_json),
    sourceTypes: parseStringArray(row.source_types_json),
    importanceScore: Number(row.importance_score) || 0,
    noveltyScore: Number(row.novelty_score) || 0,
    confidenceScore: Number(row.confidence_score) || 0,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sourceMixKey(card: MemoryCard): string {
  const sourceTypes = [...card.sourceTypes].sort();
  return sourceTypes.length > 0 ? sourceTypes.join("+") : "unknown";
}

function escapeFtsTerm(term: string): string {
  return term
    .trim()
    .replace(/["']/g, " ")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class SqliteMemoryProvider implements MemoryProvider {
  private initialized = false;

  constructor(private readonly dbPath: string = settings.paths.memoryDb) {}

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const dbDir = dirname(this.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    await this.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS memory_cards (
        card_id TEXT PRIMARY KEY,
        digest_id TEXT NOT NULL,
        date TEXT NOT NULL,
        theme_label TEXT NOT NULL,
        summary TEXT NOT NULL,
        entities_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        source_types_json TEXT NOT NULL,
        importance_score REAL NOT NULL,
        novelty_score REAL NOT NULL,
        confidence_score REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_links (
        link_id TEXT PRIMARY KEY,
        from_card_id TEXT NOT NULL,
        to_card_id TEXT NOT NULL,
        link_type TEXT NOT NULL CHECK (link_type IN ('continuation', 'counterpoint', 'duplicate')),
        strength REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_runs (
        run_id TEXT PRIMARY KEY,
        run_date TEXT NOT NULL,
        cards_created INTEGER NOT NULL,
        cards_merged INTEGER NOT NULL,
        retrieval_ms INTEGER NOT NULL,
        cards_used INTEGER NOT NULL,
        token_overhead_estimate INTEGER NOT NULL,
        notes TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_cards_fts USING fts5(
        card_id UNINDEXED,
        summary,
        theme_label,
        tags,
        entities
      );

      CREATE INDEX IF NOT EXISTS idx_memory_cards_date ON memory_cards(date);
      CREATE INDEX IF NOT EXISTS idx_memory_cards_digest_id ON memory_cards(digest_id);
      CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_card_id);
      CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_card_id);
    `);

    await this.refreshFtsIndex();

    this.initialized = true;
    logger.info(`Memory DB initialized at ${this.dbPath}`);
  }

  async ingest(
    cards: MemoryCard[],
    links: MemoryLink[],
    runMeta: MemoryIngestMeta
  ): Promise<MemoryRunStats> {
    await this.init();

    const runId = `memory-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let cardsCreated = 0;
    let cardsMerged = 0;

    const dynamicLinks = new Map<string, MemoryLink>();
    const recentCards = await this.getRecentCards(90, runMeta.runDate);

    for (const incomingRaw of cards) {
      const incoming: MemoryCard = {
        ...incomingRaw,
        updatedAt: runMeta.runDate,
      };

      let bestMatch: MemoryCard | null = null;
      let bestScore = 0;
      for (const candidate of recentCards) {
        if (candidate.cardId === incoming.cardId) {
          continue;
        }
        const score = scoreCardSimilarity(incoming, candidate).score;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = candidate;
        }
      }

      if (bestMatch && bestScore >= 0.75) {
        const merged = mergeCards(bestMatch, incoming, 0.6);
        await this.updateCard(bestMatch.cardId, merged);
        cardsMerged += 1;

        const idx = recentCards.findIndex((card) => card.cardId === bestMatch!.cardId);
        if (idx >= 0) {
          recentCards[idx] = merged;
        }

        const duplicateLink: MemoryLink = {
          linkId: `duplicate:${bestMatch.cardId}->${incoming.cardId}`,
          fromCardId: bestMatch.cardId,
          toCardId: incoming.cardId,
          linkType: "duplicate",
          strength: bestScore,
          createdAt: runMeta.runDate,
        };
        dynamicLinks.set(duplicateLink.linkId, duplicateLink);
        continue;
      }

      await this.insertCard(incoming);
      cardsCreated += 1;
      recentCards.push(incoming);

      if (bestMatch && bestScore >= 0.45 && bestScore < 0.75) {
        const continuationLink: MemoryLink = {
          linkId: `continuation:${bestMatch.cardId}->${incoming.cardId}`,
          fromCardId: bestMatch.cardId,
          toCardId: incoming.cardId,
          linkType: "continuation",
          strength: bestScore,
          createdAt: runMeta.runDate,
        };
        dynamicLinks.set(continuationLink.linkId, continuationLink);
      }
    }

    for (const link of [...links, ...dynamicLinks.values()]) {
      await this.upsertLink(link);
    }

    await this.exec(`
      INSERT INTO memory_runs (
        run_id,
        run_date,
        cards_created,
        cards_merged,
        retrieval_ms,
        cards_used,
        token_overhead_estimate,
        notes
      ) VALUES (
        ${sqlText(runId)},
        ${sqlText(toIso(runMeta.runDate))},
        ${sqlNumber(cardsCreated)},
        ${sqlNumber(cardsMerged)},
        ${sqlNumber(runMeta.retrievalMs)},
        ${sqlNumber(runMeta.cardsUsed)},
        ${sqlNumber(runMeta.tokenOverheadEstimate)},
        ${runMeta.notes ? sqlText(runMeta.notes) : "NULL"}
      );
    `);

    logger.info(
      `Memory ingest complete: ${cardsCreated} created, ${cardsMerged} merged`
    );

    return {
      runId,
      runDate: runMeta.runDate,
      cardsCreated,
      cardsMerged,
      retrievalMs: runMeta.retrievalMs,
      cardsUsed: runMeta.cardsUsed,
      tokenOverheadEstimate: runMeta.tokenOverheadEstimate,
      notes: runMeta.notes,
    };
  }

  async retrieve(query: MemoryRetrievalQuery): Promise<HistoricalContextPack> {
    await this.init();
    const startedAt = Date.now();

    const cutoff = new Date(query.now);
    cutoff.setDate(cutoff.getDate() - query.activeWindowDays);

    const terms = unique(
      [...query.topics, ...query.entities, ...query.titles]
        .map(escapeFtsTerm)
        .filter((term) => term.length >= 2)
    );

    const rows =
      terms.length > 0
        ? await this.query<Array<MemoryCardRow & { rank: number }>>(
            `
              SELECT c.*, bm25(memory_cards_fts) AS rank
              FROM memory_cards_fts
              JOIN memory_cards c ON c.card_id = memory_cards_fts.card_id
              WHERE memory_cards_fts MATCH ${sqlText(
                terms.map((term) => `"${term}"`).join(" OR ")
              )}
                AND c.date >= ${sqlText(toIso(cutoff))}
              ORDER BY rank
              LIMIT 200;
            `
          )
        : await this.query<Array<MemoryCardRow & { rank: number }>>(
            `
              SELECT c.*, 1.0 AS rank
              FROM memory_cards c
              WHERE c.date >= ${sqlText(toIso(cutoff))}
              ORDER BY c.date DESC
              LIMIT 200;
            `
          );

    const candidates: RankedCard[] = rows.map((row) => {
      const card = rowToCard(row);
      const ageMs = Math.max(0, query.now.getTime() - card.date.getTime());
      const windowMs = Math.max(1, query.activeWindowDays * 24 * 60 * 60 * 1000);
      const recency = Math.max(0, 1 - ageMs / windowMs);
      const ftsRelevance = 1 / (1 + Math.abs(Number(row.rank) || 1));
      const finalScore =
        0.45 * ftsRelevance +
        0.2 * recency +
        0.2 * card.confidenceScore +
        0.1 * card.importanceScore +
        0.05 * card.noveltyScore;

      return { card, finalScore };
    });

    candidates.sort((a, b) => b.finalScore - a.finalScore);

    const themeCounts = new Map<string, number>();
    const sourceMixCounts = new Map<string, number>();
    const selected: RankedCard[] = [];

    for (const candidate of candidates) {
      const themeCount = themeCounts.get(candidate.card.themeLabel) || 0;
      const mixKey = sourceMixKey(candidate.card);
      const mixCount = sourceMixCounts.get(mixKey) || 0;

      if (themeCount >= 4 || mixCount >= 8) {
        continue;
      }

      selected.push(candidate);
      themeCounts.set(candidate.card.themeLabel, themeCount + 1);
      sourceMixCounts.set(mixKey, mixCount + 1);

      if (selected.length >= Math.max(query.maxContextCards * 2, 30)) {
        break;
      }
    }

    const selectedIds = new Set(selected.map((entry) => entry.card.cardId));
    const linked = await this.expandLinkedCards(
      selected.slice(0, 10).map((entry) => entry.card.cardId),
      0.7
    );

    const expandedCards = linked
      .filter((entry) => !selectedIds.has(entry.card.cardId))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5)
      .map((entry) => entry.card);

    const merged = [...selected.map((entry) => entry.card), ...expandedCards];
    const budgeted = applyTokenBudget(
      merged,
      query.maxContextCards,
      query.maxContextTokens
    );

    const confirmedThreads = unique(
      selected
        .filter(
          (entry) =>
            entry.finalScore >= 0.65 &&
            entry.card.confidenceScore >= 0.6
        )
        .map((entry) => entry.card.themeLabel)
    ).slice(0, 8);

    const weakSignals = unique(
      selected
        .filter(
          (entry) =>
            entry.finalScore < 0.65 ||
            entry.card.confidenceScore < 0.55
        )
        .map((entry) => entry.card.themeLabel)
    ).slice(0, 8);

    return {
      cards: budgeted.cards,
      confirmedThreads,
      weakSignals,
      stats: {
        retrievalMs: Date.now() - startedAt,
        candidates: candidates.length,
        selected: budgeted.cards.length,
        tokenEstimate: budgeted.tokenEstimate,
      },
    };
  }

  async compact(now: Date): Promise<void> {
    await this.init();

    const latestCompactionRows = await this.query<Array<{ run_date: string }>>(
      `
        SELECT run_date
        FROM memory_runs
        WHERE notes LIKE 'compaction:%'
        ORDER BY run_date DESC
        LIMIT 1;
      `
    );

    const latestCompaction = latestCompactionRows[0];
    if (latestCompaction) {
      const lastCompactionAt = new Date(latestCompaction.run_date);
      const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
      if (now.getTime() - lastCompactionAt.getTime() < oneWeekMs) {
        return;
      }
    }

    let merged = 0;
    let removed = 0;

    const olderThan14 = new Date(now);
    olderThan14.setDate(olderThan14.getDate() - 14);
    const candidates = await this.getRecentCards(3650, now, olderThan14);

    const deletedIds = new Set<string>();
    for (let i = 0; i < candidates.length; i++) {
      const base = candidates[i];
      if (deletedIds.has(base.cardId)) {
        continue;
      }

      for (let j = i + 1; j < candidates.length; j++) {
        const next = candidates[j];
        if (deletedIds.has(next.cardId)) {
          continue;
        }

        const score = scoreCardSimilarity(base, next).score;
        if (score < 0.8) {
          continue;
        }

        const mergedCard = mergeCards(base, next, 0.5);
        await this.updateCard(base.cardId, mergedCard);
        await this.repointLinks(next.cardId, base.cardId);
        await this.deleteFtsEntry(next.cardId);
        await this.exec(`
          DELETE FROM memory_cards WHERE card_id = ${sqlText(next.cardId)};
        `);
        deletedIds.add(next.cardId);
        merged += 1;
      }
    }

    const olderThan180 = new Date(now);
    olderThan180.setDate(olderThan180.getDate() - 180);
    removed = await this.execWithChanges(`
      DELETE FROM memory_cards
      WHERE date < ${sqlText(toIso(olderThan180))}
        AND confidence_score < 0.3
        AND importance_score < 0.3
        AND card_id NOT IN (
          SELECT from_card_id FROM memory_links
          UNION
          SELECT to_card_id FROM memory_links
        );
    `);

    await this.exec(`
      DELETE FROM memory_cards_fts
      WHERE card_id NOT IN (SELECT card_id FROM memory_cards);
    `);
    await this.exec(`
      INSERT INTO memory_runs (
        run_id,
        run_date,
        cards_created,
        cards_merged,
        retrieval_ms,
        cards_used,
        token_overhead_estimate,
        notes
      ) VALUES (
        ${sqlText(`memory-compaction-${Date.now()}`)},
        ${sqlText(toIso(now))},
        0,
        ${sqlNumber(merged)},
        0,
        0,
        0,
        ${sqlText(`compaction:merged=${merged};removed=${removed}`)}
      );
    `);

    logger.info(`Memory compaction complete: merged=${merged}, removed=${removed}`);
  }

  private async getRecentCards(
    daysBack: number,
    now: Date,
    upperBound?: Date
  ): Promise<MemoryCard[]> {
    const lowerBound = new Date(now);
    lowerBound.setDate(lowerBound.getDate() - daysBack);

    const rows =
      upperBound !== undefined
        ? await this.query<MemoryCardRow[]>(
            `
              SELECT *
              FROM memory_cards
              WHERE date >= ${sqlText(toIso(lowerBound))}
                AND date <= ${sqlText(toIso(upperBound))}
              ORDER BY date DESC;
            `
          )
        : await this.query<MemoryCardRow[]>(
            `
              SELECT *
              FROM memory_cards
              WHERE date >= ${sqlText(toIso(lowerBound))}
              ORDER BY date DESC;
            `
          );

    return rows.map(rowToCard);
  }

  private async expandLinkedCards(
    cardIds: string[],
    minStrength: number
  ): Promise<Array<{ card: MemoryCard; strength: number }>> {
    if (cardIds.length === 0) {
      return [];
    }

    const quotedIds = cardIds.map((cardId) => sqlText(cardId)).join(", ");
    const rows = await this.query<Array<{ linked_card_id: string; strength: number }>>(
      `
        SELECT
          CASE
            WHEN from_card_id IN (${quotedIds}) THEN to_card_id
            ELSE from_card_id
          END AS linked_card_id,
          strength
        FROM memory_links
        WHERE (from_card_id IN (${quotedIds}) OR to_card_id IN (${quotedIds}))
          AND strength >= ${sqlNumber(minStrength)};
      `
    );

    const linkedStrength = new Map<string, number>();
    for (const row of rows) {
      const previous = linkedStrength.get(row.linked_card_id) || 0;
      linkedStrength.set(row.linked_card_id, Math.max(previous, row.strength));
    }

    const linkedCardIds = [...linkedStrength.keys()];
    if (linkedCardIds.length === 0) {
      return [];
    }

    const cards = await this.query<MemoryCardRow[]>(
      `
        SELECT *
        FROM memory_cards
        WHERE card_id IN (${linkedCardIds.map((id) => sqlText(id)).join(", ")});
      `
    );

    return cards.map((row) => ({
      card: rowToCard(row),
      strength: linkedStrength.get(row.card_id) || 0,
    }));
  }

  private async insertCard(card: MemoryCard): Promise<void> {
    await this.exec(`
      INSERT INTO memory_cards (
        card_id,
        digest_id,
        date,
        theme_label,
        summary,
        entities_json,
        tags_json,
        evidence_refs_json,
        source_types_json,
        importance_score,
        novelty_score,
        confidence_score,
        created_at,
        updated_at
      ) VALUES (
        ${sqlText(card.cardId)},
        ${sqlText(card.digestId)},
        ${sqlText(toIso(card.date))},
        ${sqlText(card.themeLabel)},
        ${sqlText(card.summary)},
        ${sqlArray(card.entities)},
        ${sqlArray(card.tags)},
        ${sqlArray(card.evidenceRefs)},
        ${sqlArray(card.sourceTypes)},
        ${sqlNumber(card.importanceScore)},
        ${sqlNumber(card.noveltyScore)},
        ${sqlNumber(card.confidenceScore)},
        ${sqlText(toIso(card.createdAt))},
        ${sqlText(toIso(card.updatedAt))}
      )
      ON CONFLICT(card_id) DO UPDATE SET
        digest_id = excluded.digest_id,
        date = excluded.date,
        theme_label = excluded.theme_label,
        summary = excluded.summary,
        entities_json = excluded.entities_json,
        tags_json = excluded.tags_json,
        evidence_refs_json = excluded.evidence_refs_json,
        source_types_json = excluded.source_types_json,
        importance_score = excluded.importance_score,
        novelty_score = excluded.novelty_score,
        confidence_score = excluded.confidence_score,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at;
    `);
    await this.upsertFtsEntry(card);
  }

  private async updateCard(cardId: string, card: MemoryCard): Promise<void> {
    await this.exec(`
      UPDATE memory_cards
      SET
        digest_id = ${sqlText(card.digestId)},
        date = ${sqlText(toIso(card.date))},
        theme_label = ${sqlText(card.themeLabel)},
        summary = ${sqlText(card.summary)},
        entities_json = ${sqlArray(card.entities)},
        tags_json = ${sqlArray(card.tags)},
        evidence_refs_json = ${sqlArray(card.evidenceRefs)},
        source_types_json = ${sqlArray(card.sourceTypes)},
        importance_score = ${sqlNumber(card.importanceScore)},
        novelty_score = ${sqlNumber(card.noveltyScore)},
        confidence_score = ${sqlNumber(card.confidenceScore)},
        created_at = ${sqlText(toIso(card.createdAt))},
        updated_at = ${sqlText(toIso(card.updatedAt))}
      WHERE card_id = ${sqlText(cardId)};
    `);
    await this.upsertFtsEntry(card);
  }

  private async upsertLink(link: MemoryLink): Promise<void> {
    await this.exec(`
      INSERT INTO memory_links (
        link_id,
        from_card_id,
        to_card_id,
        link_type,
        strength,
        created_at
      ) VALUES (
        ${sqlText(link.linkId)},
        ${sqlText(link.fromCardId)},
        ${sqlText(link.toCardId)},
        ${sqlText(link.linkType)},
        ${sqlNumber(link.strength)},
        ${sqlText(toIso(link.createdAt))}
      )
      ON CONFLICT(link_id) DO UPDATE SET
        strength = excluded.strength,
        created_at = excluded.created_at;
    `);
  }

  private async repointLinks(fromCardId: string, toCardId: string): Promise<void> {
    await this.exec(`
      UPDATE memory_links
      SET from_card_id = ${sqlText(toCardId)}
      WHERE from_card_id = ${sqlText(fromCardId)};
    `);

    await this.exec(`
      UPDATE memory_links
      SET to_card_id = ${sqlText(toCardId)}
      WHERE to_card_id = ${sqlText(fromCardId)};
    `);
  }

  private async execWithChanges(sql: string): Promise<number> {
    const rows = await this.query<Array<{ changes: number }>>(
      `${sql}\nSELECT changes() AS changes;`
    );
    return Number(rows[0]?.changes) || 0;
  }

  private async refreshFtsIndex(): Promise<void> {
    await this.exec(`
      DELETE FROM memory_cards_fts;
      INSERT INTO memory_cards_fts (card_id, summary, theme_label, tags, entities)
      SELECT card_id, summary, theme_label, tags_json, entities_json
      FROM memory_cards;
    `);
  }

  private async upsertFtsEntry(card: MemoryCard): Promise<void> {
    await this.exec(`
      DELETE FROM memory_cards_fts WHERE card_id = ${sqlText(card.cardId)};
      INSERT INTO memory_cards_fts (card_id, summary, theme_label, tags, entities)
      VALUES (
        ${sqlText(card.cardId)},
        ${sqlText(card.summary)},
        ${sqlText(card.themeLabel)},
        ${sqlArray(card.tags)},
        ${sqlArray(card.entities)}
      );
    `);
  }

  private async deleteFtsEntry(cardId: string): Promise<void> {
    await this.exec(`
      DELETE FROM memory_cards_fts WHERE card_id = ${sqlText(cardId)};
    `);
  }

  private async exec(sql: string): Promise<void> {
    await this.execSql(sql, false);
  }

  private async query<T>(sql: string): Promise<T> {
    const output = await this.execSql(sql, true);
    if (!output.trim()) {
      return [] as T;
    }
    return JSON.parse(output) as T;
  }

  private async execSql(sql: string, json: boolean): Promise<string> {
    const sqlWithPragmas = `PRAGMA trusted_schema=ON;\n${sql}`;
    const args = json
      ? ["-json", this.dbPath, sqlWithPragmas]
      : [this.dbPath, sqlWithPragmas];

    const { stdout, stderr } = await execFileAsync("sqlite3", args, {
      maxBuffer: 20 * 1024 * 1024,
    });

    if (stderr && stderr.trim().length > 0) {
      throw new Error(stderr.trim());
    }

    return stdout || "";
  }
}
