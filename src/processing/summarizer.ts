import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createLogger } from "../utils/logger.js";
import { settings, sourcesConfig } from "../config/settings.js";
import { getCAIOContextString } from "../../config/caio-context/index.js";
import { formatHistoricalContext } from "./memory-retriever.js";
import type {
  SourceItem,
  SummarizedItem,
  GmailNewsletter,
  NewsletterStory,
  SynthesizedTheme,
  ExecutiveBrief,
  HistoricalContextPack,
} from "../sources/types.js";

const logger = createLogger("Summarizer");

const client = new Anthropic();

// Use the Anthropic SDK's default timeout (600s / 10 min).
// Synthesis needs 2-5 minutes with large input + 48K output budget.
// Individual summarization calls complete in 5-10s but use the same
// generous timeout — Promise.allSettled isolates any slow call.
const DEBUG_DUMP_DIR = join(settings.paths.dataDir, "debug-dumps");

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
    .replace("{content}", item.content.slice(0, 16000));

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

const DECOMPOSE_PROMPT_SHORT = `You are parsing an email newsletter into its individual stories/segments.

Newsletter: {subject}
From: {from}
Content:
---
{body}
---

Extract each discrete story/topic as a separate item. Return at most 8 stories.
For content, use 2-3 sentences per story instead of full text.

For each:
- title: A descriptive headline for this story
- content: 2-3 sentence summary of the story segment
- urls: Any URLs/links within this story
- isSponsored: true if this is a sponsored/ad section

Respond in JSON format only: { "stories": [...] }

Rules:
- Split on topic boundaries, not paragraphs
- Keep content brief — 2-3 sentences max
- Capture all URLs within each story
- Mark sponsored/ad sections clearly
- If the newsletter is a single-topic deep dive, return one story
- Exclude boilerplate (unsubscribe, footer, masthead)`;

function parseDecomposedJson(text: string): NewsletterStory[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in response");
  }

  const repairedJson = jsonrepair(jsonMatch[0]);
  const result = JSON.parse(repairedJson);
  const stories: NewsletterStory[] = result.stories || [];

  if (stories.length === 0) {
    throw new Error("Decomposition returned zero stories");
  }

  return stories;
}

export async function decomposeNewsletter(
  newsletter: GmailNewsletter
): Promise<NewsletterStory[]> {
  const prompt = DECOMPOSE_PROMPT.replace("{subject}", newsletter.subject)
    .replace("{from}", newsletter.from)
    .replace("{body}", newsletter.body.slice(0, 15000));

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    const stories = parseDecomposedJson(text);

    logger.info(
      `Decomposed "${newsletter.subject}" into ${stories.length} stories`
    );
    return stories;
  } catch (error) {
    logger.warn(
      `First decomposition attempt failed for "${newsletter.subject}", retrying with constrained prompt`,
      error
    );

    // Retry with constrained prompt (shorter output)
    try {
      const retryPrompt = DECOMPOSE_PROMPT_SHORT.replace(
        "{subject}",
        newsletter.subject
      )
        .replace("{from}", newsletter.from)
        .replace("{body}", newsletter.body.slice(0, 10000));

      const retryResponse = await client.messages.create({
        model: settings.claude.model,
        max_tokens: 8000,
        messages: [{ role: "user", content: retryPrompt }],
      });

      const retryText =
        retryResponse.content[0].type === "text"
          ? retryResponse.content[0].text
          : "";

      const stories = parseDecomposedJson(retryText);

      logger.info(
        `Decomposed "${newsletter.subject}" into ${stories.length} stories (retry succeeded)`
      );
      return stories;
    } catch (retryError) {
      logger.error(
        `Failed to decompose newsletter after retry: ${newsletter.subject}`,
        retryError
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

HISTORICAL CONTEXT (PAST 60 DAYS + LINKED PRIOR):
---
{historicalContext}
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
   enterprise/adoption implications where relevant. Each insight must state WHY it
   matters — not just THAT it exists. End each insight with the concrete implication.
4. noveltySignal: Classify as "breaking" (new in last 24h), "evolution" (of a known
   trend), or "confirmation" (of a previously reported topic).
5. sources: Which items contribute to this theme (with brief snippets for attribution)

Respond in JSON format only: { "themes": [...] }

Each theme object:
{
  "theme": "...",
  "narrative": "...",
  "keyInsights": ["..."],
  "noveltySignal": "breaking|evolution|confirmation",
  "sources": [{ "title": "...", "author": "...", "sourceType": "bookmark|newsletter|account|rss|web-scout", "snippet": "...", "url": "..." }]
}

Rules:
- Every source item should appear in at least one theme
- Themes should reveal connections that aren't obvious from reading items individually
- Themes backed by multiple source types (tweets + newsletters + RSS + web scout) carry more weight. Note the source diversity.
- Each theme must reference at least 2 items. Single-source observations should be folded into broader themes.
- If a topic has only one source, it can be a minor theme or folded into a larger one
- Don't force groupings — if sources are unrelated, fewer themes is fine
- Be precise, substantive, and technically grounded. No hype language.
- When research papers or technical breakthroughs come up, explain WHY they matter,
  not just THAT they exist.
- Don't artificially separate "technical" from "business" — if a model release has
  enterprise implications, say so in the same theme.
- Clearly separate:
  - today-only signals,
  - cross-day confirmed threads (backed by historical context),
  - weak/early signals that need monitoring.
- Do not overstate memory confidence: if historical support is weak, say so explicitly.`;

function dumpFailedResponse(
  text: string,
  stopReason: string,
  error: unknown,
  label: string
): void {
  try {
    if (!existsSync(DEBUG_DUMP_DIR)) {
      mkdirSync(DEBUG_DUMP_DIR, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filepath = join(DEBUG_DUMP_DIR, `synthesis-${label}-${ts}.txt`);
    const dump = [
      `stop_reason: ${stopReason}`,
      `error: ${error instanceof Error ? error.message : String(error)}`,
      `timestamp: ${new Date().toISOString()}`,
      `---`,
      text,
    ].join("\n");
    writeFileSync(filepath, dump);
    logger.warn(`Dumped failed synthesis response to: ${filepath}`);
  } catch (dumpError) {
    logger.warn("Failed to dump synthesis response", dumpError);
  }
}

function parseSynthesisJson(text: string): SynthesizedTheme[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON found in synthesis response");
  }

  const repairedJson = jsonrepair(jsonMatch[0]);
  const result = JSON.parse(repairedJson);
  const themes: SynthesizedTheme[] = result.themes || [];

  if (themes.length === 0) {
    throw new Error("Synthesis returned zero themes");
  }

  return themes;
}

function enrichThemeMetadata(themes: SynthesizedTheme[]): void {
  for (const theme of themes) {
    // Compute source diversity: count of distinct source types
    const sourceTypes = new Set(theme.sources.map((s) => s.sourceType));
    theme.sourceDiversity = sourceTypes.size;

    // Validate noveltySignal — default to "evolution" if missing/invalid
    const validSignals = ["breaking", "evolution", "confirmation"] as const;
    if (!theme.noveltySignal || !validSignals.includes(theme.noveltySignal as any)) {
      theme.noveltySignal = "evolution";
    }
  }
}

export async function synthesizeDigest(
  allItems: SummarizedItem[],
  accountTweets: SourceItem[],
  historicalContext?: HistoricalContextPack
): Promise<SynthesizedTheme[]> {
  if (allItems.length === 0 && accountTweets.length === 0) {
    return [];
  }

  logger.info(
    `Synthesizing themes from ${allItems.length} items, ${accountTweets.length} account tweets, ${historicalContext?.cards.length || 0} memory cards`
  );

  const itemsList = allItems
    .map(
      (item) =>
        `Title: ${item.title}\nSource: ${item.source}${item.twitterSourceType ? ` (${item.twitterSourceType})` : ""}${item.newsletterName ? ` [${item.newsletterName}]` : ""}${item.feedName ? ` [${item.feedName}]` : ""}\nAuthor: ${item.author || "Unknown"}\nSummary: ${item.summary}\nKey Takeaways: ${item.keyTakeaways.join("; ")}\nSource Content (excerpt): ${item.content.slice(0, 2000)}\nURL: ${item.url || "none"}`
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

  const historicalContextText = formatHistoricalContext(historicalContext);

  const prompt = SYNTHESIS_PROMPT.replace("{items}", itemsList)
    .replace("{accountTweets}", accountTweetsList)
    .replace("{historicalContext}", historicalContextText);

  // First attempt
  let firstResponseText = "";
  let firstStopReason = "unknown";
  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: 48000,
      messages: [{ role: "user", content: prompt }],
    });

    firstStopReason = response.stop_reason || "unknown";

    if (response.stop_reason === "max_tokens") {
      logger.warn(
        "Synthesis response was truncated (stop_reason: max_tokens) — attempting parse with jsonrepair"
      );
    }

    firstResponseText =
      response.content[0].type === "text" ? response.content[0].text : "";

    const themes = parseSynthesisJson(firstResponseText);
    enrichThemeMetadata(themes);

    logger.info(
      `Synthesized ${themes.length} themes from ${allItems.length} items`
    );
    return themes;
  } catch (firstError) {
    logger.warn(
      "First synthesis attempt failed, retrying with constrained prompt",
      firstError
    );

    dumpFailedResponse(
      firstResponseText || "(no response text — API call may have failed)",
      firstStopReason,
      firstError,
      "attempt1"
    );

    // Retry with constrained output
    try {
      const constrainedPrompt =
        prompt +
        "\n\nIMPORTANT: Return at most 5 themes. Keep narratives to 2-3 sentences. Keep keyInsights to 2-3 per theme. Be concise.";

      const retryResponse = await client.messages.create({
        model: settings.claude.model,
        max_tokens: 48000,
        messages: [{ role: "user", content: constrainedPrompt }],
      });

      if (retryResponse.stop_reason === "max_tokens") {
        logger.warn(
          "Retry synthesis response was also truncated (stop_reason: max_tokens)"
        );
      }

      const retryText =
        retryResponse.content[0].type === "text"
          ? retryResponse.content[0].text
          : "";

      const themes = parseSynthesisJson(retryText);
      enrichThemeMetadata(themes);

      logger.info(
        `Synthesized ${themes.length} themes from ${allItems.length} items (retry succeeded)`
      );
      return themes;
    } catch (retryError) {
      logger.error(
        "Failed to synthesize digest themes after retry",
        retryError
      );
      dumpFailedResponse("(retry failed)", "unknown", retryError, "attempt2");
      return [];
    }
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
      max_tokens: 4000,
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
