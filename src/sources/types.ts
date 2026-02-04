export interface SourceItem {
  id: string;
  source: "twitter" | "gmail";
  title: string;
  content: string;
  url?: string;
  author?: string;
  publishedAt: Date;
  extractedAt: Date;
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

export interface SummarizedItem extends SourceItem {
  summary: string;
  keyTakeaways: string[];
  aiRelevanceScore: number;
  topics: string[];
}

export interface DigestSection {
  topic: string;
  items: SummarizedItem[];
}

export interface Digest {
  id: string;
  generatedAt: Date;
  executiveSummary: string;
  topStories: SummarizedItem[];
  sections: DigestSection[];
  sourceStats: {
    twitterCount: number;
    gmailCount: number;
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
