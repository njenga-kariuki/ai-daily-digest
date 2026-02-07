import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../utils/logger.js";
import { settings, sourcesConfig } from "../config/settings.js";
import { getCAIOContextString } from "../config/caio-context/index.js";
import type {
  SourceItem,
  SummarizedItem,
  GmailNewsletter,
  NewsletterStory,
  SynthesizedTheme,
  ExecutiveBrief,
} from "../sources/types.js";

const logger = createLogger("Summarizer");

const client = new Anthropic();

// --- Individual Item Summarization ---

interface SummaryResult {
  summary: string;
  keyTakeaways: string[];
  aiRelevanceScore: number;
  topics: string[];
}

const SUMMARIZE_PROMPT = `You are an AI news analyst. Analyze the following content and provide a structured summary focused on AI/ML developments.

Focus areas: ${sourcesConfig.processing.focusAreas.join(", ")}

Content to analyze:
---
Title: {title}
Source: {source}
Author: {author}
Content:
{content}
---

Respond in JSON format only:
{
  "summary": "2-3 sentence summary highlighting what's new/important",
  "keyTakeaways": ["takeaway 1", "takeaway 2", "takeaway 3"],
  "aiRelevanceScore": 0.0-1.0,
  "topics": ["topic1", "topic2"]
}

Guidelines:
- aiRelevanceScore: 1.0 = directly about AI/ML, 0.5 = tangentially related, 0.0 = not AI related
- topics: use consistent labels like "LLMs", "Computer Vision", "AI Tools", "AI Policy", "Research", "Industry", "Startups"
- keyTakeaways: focus on actionable insights or significant developments
- If content is not AI-related, still provide a brief summary but score appropriately`;

export async function summarizeItem(
  item: SourceItem
): Promise<SummarizedItem> {
  const prompt = SUMMARIZE_PROMPT.replace("{title}", item.title)
    .replace("{source}", item.source)
    .replace("{author}", item.author || "Unknown")
    .replace("{content}", item.content.slice(0, 8000));

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: settings.claude.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const result: SummaryResult = JSON.parse(jsonMatch[0]);

    return {
      ...item,
      summary: result.summary,
      keyTakeaways: result.keyTakeaways,
      aiRelevanceScore: result.aiRelevanceScore,
      topics: result.topics,
    };
  } catch (error) {
    logger.warn(`Failed to summarize item: ${item.title}`, error);
    return {
      ...item,
      summary: item.content.slice(0, 200) + "...",
      keyTakeaways: [],
      aiRelevanceScore: 0.5,
      topics: ["Uncategorized"],
    };
  }
}

export async function summarizeItems(
  items: SourceItem[]
): Promise<SummarizedItem[]> {
  logger.info(`Summarizing ${items.length} items with Claude`);

  const results: SummarizedItem[] = [];

  const batchSize = 5;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map((item) => summarizeItem(item))
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      }
    }

    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  logger.info(`Successfully summarized ${results.length} items`);
  return results;
}

// --- Newsletter Decomposition ---

const DECOMPOSE_PROMPT = `You are parsing an email newsletter into its individual stories/segments.

Newsletter: {subject}
From: {from}
Content:
---
{body}
---

Extract each discrete story/topic as a separate item. For each:
- title: A descriptive headline for this story
- content: The full text of this story segment (preserve detail)
- urls: Any URLs/links that appear within this story's content
- isSponsored: true if this is a sponsored/ad section

Respond in JSON format only: { "stories": [...] }

Rules:
- Split on topic boundaries, not paragraphs
- Preserve the full content of each story (don't summarize here)
- Capture all URLs within each story — these link to the deeper source material
- Mark sponsored/ad sections clearly
- If the newsletter is a single-topic deep dive, return one story
- Exclude boilerplate (unsubscribe, footer, masthead)`;

export async function decomposeNewsletter(
  newsletter: GmailNewsletter
): Promise<NewsletterStory[]> {
  const prompt = DECOMPOSE_PROMPT.replace("{subject}", newsletter.subject)
    .replace("{from}", newsletter.from)
    .replace("{body}", newsletter.body.slice(0, 15000));

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: settings.claude.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]);
    const stories: NewsletterStory[] = result.stories || [];

    logger.info(
      `Decomposed "${newsletter.subject}" into ${stories.length} stories`
    );
    return stories;
  } catch (error) {
    logger.error(
      `Failed to decompose newsletter: ${newsletter.subject}`,
      error
    );
    // Fallback: return the whole newsletter as a single story
    return [
      {
        title: newsletter.subject,
        content: newsletter.body,
        urls: newsletter.urls,
        isSponsored: false,
      },
    ];
  }
}

// --- Cross-Source Narrative Synthesis ---

const SYNTHESIS_PROMPT = `You are producing an AI intelligence brief. The reader follows AI at multiple levels:
- Technically: research breakthroughs, tools, code, things to experiment with hands-on
- Strategically: enterprise adoption, market dynamics, competitive moves, build/buy signals
- Culturally: workforce shifts, organizational change, community trends, regulatory moves

They want the full picture — what's real, what's hype, and what's actually changing.

Your job: find the narrative threads across today's sources and weave them into a
coherent picture of what's happening in AI right now.

SUMMARIZED CONTENT:
---
{items}
---

RAW COMMUNITY SIGNALS (tweets from AI researchers/practitioners):
---
{accountTweets}
---

Identify the thematic threads that connect multiple sources. Let the material determine
how many themes there are — a light news day might have 2-3, a dense day might have 8+.
Don't force groupings and don't artificially cap.

For each theme:
1. theme: Concise theme title
2. narrative: A substantive synthesis (not just a list) of what multiple sources reveal
   about this topic. Connect the dots — show what's significant, what's changing, and
   why these things matter together. Write with intellectual depth. Length should match
   the theme's complexity — a major development warrants more than a minor one.
3. keyInsights: The specific insights that matter for this theme. Include as many or
   as few as are genuinely significant — don't pad, don't truncate. Include technical
   detail where it matters. Flag what's worth experimenting with hands-on. Note
   enterprise/adoption implications where relevant.
4. sources: Which items contribute to this theme (with brief snippets for attribution)

Respond in JSON format only: { "themes": [...] }

Each theme object:
{
  "theme": "...",
  "narrative": "...",
  "keyInsights": ["..."],
  "sources": [{ "title": "...", "author": "...", "sourceType": "bookmark|newsletter|account", "snippet": "...", "url": "..." }]
}

Rules:
- Every source item should appear in at least one theme
- Themes should reveal connections that aren't obvious from reading items individually
- Prioritize themes with signal from multiple source types (tweets + newsletters + bookmarks)
- If a topic has only one source, it can be a minor theme or folded into a larger one
- Don't force groupings — if sources are unrelated, fewer themes is fine
- Be precise, substantive, and technically grounded. No hype language.
- When research papers or technical breakthroughs come up, explain WHY they matter,
  not just THAT they exist.
- Don't artificially separate "technical" from "business" — if a model release has
  enterprise implications, say so in the same theme.`;

export async function synthesizeDigest(
  allItems: SummarizedItem[],
  accountTweets: SourceItem[]
): Promise<SynthesizedTheme[]> {
  if (allItems.length === 0 && accountTweets.length === 0) {
    return [];
  }

  logger.info(
    `Synthesizing themes from ${allItems.length} items and ${accountTweets.length} account tweets`
  );

  const itemsList = allItems
    .map(
      (item) =>
        `Title: ${item.title}\nSource: ${item.source}${item.twitterSourceType ? ` (${item.twitterSourceType})` : ""}${item.newsletterName ? ` [${item.newsletterName}]` : ""}\nAuthor: ${item.author || "Unknown"}\nSummary: ${item.summary}\nKey Takeaways: ${item.keyTakeaways.join("; ")}\nURL: ${item.url || "none"}`
    )
    .join("\n\n---\n\n");

  const accountTweetsList =
    accountTweets.length > 0
      ? accountTweets
          .map(
            (t) =>
              `@${t.author || "unknown"}: ${t.content.slice(0, 500)}${t.url ? ` [${t.url}]` : ""}`
          )
          .join("\n\n")
      : "(No community tweets today)";

  const prompt = SYNTHESIS_PROMPT.replace("{items}", itemsList).replace(
    "{accountTweets}",
    accountTweetsList
  );

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]);
    const themes: SynthesizedTheme[] = result.themes || [];

    logger.info(
      `Synthesized ${themes.length} themes from ${allItems.length} items`
    );
    return themes;
  } catch (error) {
    logger.error("Failed to synthesize digest themes", error);
    return [];
  }
}

// --- CAIO Executive Brief ---

const CAIO_BRIEF_PROMPT = `You are the strategic AI advisor to the AI leader.

ROLE & COMPANY CONTEXT:
---
{context}
---

Based on today's synthesized themes and the underlying sources, produce a rigorous
strategic brief. Think like an advisor who has worked inside this company for years
and understands the specific operational realities, not a consultant parachuting in.

TODAY'S THEMES:
---
{themes}
---

ALL SOURCE SUMMARIES:
---
{items}
---

Produce:

1. headline: One sentence — the single most strategically significant development
   for Safaricom's AI transformation today.

2. strategicInsights: Each must:
   - Connect a specific development to a specific priority from the role context
   - Include concrete reasoning (not "consider AI" but "M-Pesa's fraud detection
     could leverage X because Y, given the scale of Z")
   - Where appropriate, specify the decision type: build/buy/partner, invest/wait,
     accelerate/deprioritize
   - Be intellectually honest — flag uncertainty and counter-arguments
   Include as many insights as the material genuinely warrants. A few rigorous
   insights are better than many shallow ones, but don't artificially cap if the
   day's news has broad strategic relevance.

3. watchList: Emerging signals not yet actionable but potentially strategic within
   3-6 months. Include WHY this matters for Safaricom specifically. Include as many
   or as few as are genuinely worth monitoring — don't pad and don't force a minimum.

Respond in JSON format only:
{
  "headline": "...",
  "strategicInsights": ["...", "..."],
  "watchList": ["...", "..."]
}

Rules:
- No generic advice. Ground every insight in the specific company context provided.
- If today's news has limited direct relevance, say so honestly — don't force connections.
- Prefer depth over breadth.
- Reference specific capabilities, products, or challenges from the context.`;

export async function generateExecutiveBrief(
  allItems: SummarizedItem[],
  themes: SynthesizedTheme[]
): Promise<ExecutiveBrief | null> {
  if (allItems.length === 0 && themes.length === 0) {
    return null;
  }

  logger.info("Generating CAIO executive brief");

  const caioContext = getCAIOContextString();

  const themesText = themes
    .map(
      (t) =>
        `${t.theme}:\n${t.narrative}\nInsights: ${t.keyInsights.join("; ")}`
    )
    .join("\n\n---\n\n");

  const itemsText = allItems
    .sort((a, b) => b.aiRelevanceScore - a.aiRelevanceScore)
    .slice(0, 20)
    .map((item) => `- ${item.title}: ${item.summary}`)
    .join("\n");

  const prompt = CAIO_BRIEF_PROMPT.replace("{context}", caioContext)
    .replace("{themes}", themesText)
    .replace("{items}", itemsText);

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const result = JSON.parse(jsonMatch[0]);

    const brief: ExecutiveBrief = {
      headline: result.headline || "",
      strategicInsights: result.strategicInsights || [],
      watchList: result.watchList || [],
    };

    logger.info(
      `Generated CAIO brief: ${brief.strategicInsights.length} insights, ${brief.watchList.length} watch items`
    );
    return brief;
  } catch (error) {
    logger.error("Failed to generate executive brief", error);
    return null;
  }
}
