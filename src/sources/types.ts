export interface SourceItem {
  id: string;
  source: "twitter" | "gmail";
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
  allItems: SummarizedItem[];
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
