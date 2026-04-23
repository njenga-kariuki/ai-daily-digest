import type {
  HistoricalContextPack,
  MemoryCard,
  MemoryLink,
  MemoryRetrievalQuery,
  MemoryRunStats,
} from "../sources/types.js";

export interface MemoryIngestMeta {
  runDate: Date;
  retrievalMs: number;
  cardsUsed: number;
  tokenOverheadEstimate: number;
  notes?: string;
}

export interface MemoryProvider {
  init(): Promise<void>;
  ingest(
    cards: MemoryCard[],
    links: MemoryLink[],
    runMeta: MemoryIngestMeta
  ): Promise<MemoryRunStats>;
  retrieve(query: MemoryRetrievalQuery): Promise<HistoricalContextPack>;
  compact(now: Date): Promise<void>;
}

export interface ManagedMemoryProvider extends MemoryProvider {
  providerName: string;
}

export class NoopMemoryProvider implements MemoryProvider {
  constructor(private readonly reason: string = "disabled") {}

  async init(): Promise<void> {}

  async ingest(
    _cards: MemoryCard[],
    _links: MemoryLink[],
    runMeta: MemoryIngestMeta
  ): Promise<MemoryRunStats> {
    return {
      runId: `noop-${Date.now()}`,
      runDate: runMeta.runDate,
      cardsCreated: 0,
      cardsMerged: 0,
      retrievalMs: runMeta.retrievalMs,
      cardsUsed: runMeta.cardsUsed,
      tokenOverheadEstimate: runMeta.tokenOverheadEstimate,
      notes: this.reason,
    };
  }

  async retrieve(_query: MemoryRetrievalQuery): Promise<HistoricalContextPack> {
    return {
      cards: [],
      priorFlags: [],
      confirmedThreads: [],
      weakSignals: [],
      stats: {
        retrievalMs: 0,
        candidates: 0,
        selected: 0,
        tokenEstimate: 0,
      },
    };
  }

  async compact(_now: Date): Promise<void> {}
}
