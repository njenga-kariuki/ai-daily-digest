export interface SourceItem {
  id: string;
  source: "twitter" | "gmail" | "rss" | "web-scout";
  title: string;
  content: string;
  url?: string;
  author?: string;
  publishedAt: Date;
  extractedAt: Date;
  twitterSourceType?: "bookmark" | "account";
  sourceAccount?: string;
  parentNewsletterId?: string;
  newsletterName?: string;
  feedName?: string;
}

export interface TwitterBookmark {
  id: string;
  text: string;
  authorName: string;
  authorUsername: string;
  authorId?: string;
  createdAt: Date;
  urls: string[];
  conversationId?: string;
  threadContent?: string; // Combined content from thread (author's tweets only)
  sourceType: "bookmark" | "account";
  sourceAccount?: string; // Which account (if sourceType === "account")
}

export interface GmailNewsletter {
  id: string;
  subject: string;
  from: string;
  body: string;
  receivedAt: Date;
  urls: string[];
}

export interface ExtractedArticle {
  url: string;
  title: string;
  content: string;
  author?: string;
  publishedAt?: Date;
  siteName?: string;
  hasTranscript?: boolean; // For YouTube videos: whether transcript was extracted
}

export interface NewsletterStory {
  title: string;
  content: string;
  urls: string[];
  isSponsored: boolean;
}

export interface SummarizedItem extends SourceItem {
  summary: string;
  keyTakeaways: string[];
  aiRelevanceScore: number;
  topics: string[];
}

export interface SynthesizedTheme {
  theme: string;
  narrative: string;
  keyInsights: string[];
  noveltySignal?: "breaking" | "evolution" | "confirmation";
  sourceDiversity?: number;
  crossDaySignals?: {
    confirmedThreads: string[];
    weakSignals: string[];
  };
  sources: Array<{
    title: string;
    author: string;
    sourceType: string;
    snippet: string;
    url?: string;
  }>;
}

export interface ExecutiveBrief {
  headline: string;
  strategicInsights: string[];
  watchList: string[];
}

export interface Digest {
  id: string;
  generatedAt: Date;
  executiveBrief?: ExecutiveBrief;
  themes: SynthesizedTheme[];
  crossConnections?: string[];
  allItems: SummarizedItem[];
  alsoNotable?: SummarizedItem[];
  footnotes?: SummarizedItem[];
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
  };
  errors: string[];
}

export interface ProcessedIds {
  twitter: Set<string>;
  gmail: Set<string>;
  articles: Set<string>;
}

export interface MemoryEvidenceRef {
  itemId?: string;
  url?: string;
  title?: string;
}

export interface MemoryCard {
  cardId: string;
  digestId: string;
  date: Date;
  themeLabel: string;
  summary: string;
  entities: string[];
  tags: string[];
  evidenceRefs: MemoryEvidenceRef[];
  sourceTypes: string[];
  importanceScore: number;
  noveltyScore: number;
  confidenceScore: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryLink {
  linkId: string;
  fromCardId: string;
  toCardId: string;
  linkType: "continuation" | "counterpoint" | "duplicate";
  strength: number;
  createdAt: Date;
}

export interface MemoryRunStats {
  runId: string;
  runDate: Date;
  cardsCreated: number;
  cardsMerged: number;
  retrievalMs: number;
  cardsUsed: number;
  tokenOverheadEstimate: number;
  notes?: string;
}

export interface MemoryRetrievalQuery {
  now: Date;
  activeWindowDays: number;
  maxContextCards: number;
  maxContextTokens: number;
  topics: string[];
  entities: string[];
  titles: string[];
}

export interface HistoricalContextPack {
  cards: MemoryCard[];
  priorFlags: MemoryCard[];
  confirmedThreads: string[];
  weakSignals: string[];
  stats: {
    retrievalMs: number;
    candidates: number;
    selected: number;
    tokenEstimate: number;
  };
}
