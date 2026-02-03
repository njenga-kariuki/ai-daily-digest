import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../utils/logger.js";
import { settings, sourcesConfig } from "../config/settings.js";
import type { SourceItem, SummarizedItem } from "../sources/types.js";

const logger = createLogger("Summarizer");

const client = new Anthropic();

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

export async function summarizeItem(item: SourceItem): Promise<SummarizedItem> {
  const prompt = SUMMARIZE_PROMPT.replace("{title}", item.title)
    .replace("{source}", item.source)
    .replace("{author}", item.author || "Unknown")
    .replace("{content}", item.content.slice(0, 8000)); // Limit content length

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: settings.claude.maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Extract JSON from response (handle potential markdown wrapping)
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
    // Return item with default values on failure
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

  // Process in batches to respect rate limits
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

    // Rate limit delay between batches
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  logger.info(`Successfully summarized ${results.length} items`);
  return results;
}

export async function generateExecutiveSummary(
  items: SummarizedItem[]
): Promise<string> {
  const topItems = items
    .sort((a, b) => b.aiRelevanceScore - a.aiRelevanceScore)
    .slice(0, 10);

  const itemList = topItems
    .map((item, i) => `${i + 1}. ${item.title}: ${item.summary}`)
    .join("\n");

  const prompt = `You are writing the executive summary for a daily AI news digest.

Today's top stories:
${itemList}

Write a 3-4 sentence executive summary that:
1. Highlights the most significant AI development of the day
2. Notes any emerging themes or trends
3. Identifies anything practitioners should pay attention to

Be direct and insightful. Write for a technical audience who wants signal, not fluff.`;

  try {
    const response = await client.messages.create({
      model: settings.claude.model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    return response.content[0].type === "text"
      ? response.content[0].text
      : "Unable to generate executive summary.";
  } catch (error) {
    logger.error("Failed to generate executive summary", error);
    return "Unable to generate executive summary due to an error.";
  }
}
