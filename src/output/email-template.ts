import type { Digest, SummarizedItem, ThemeSummary, ExecutiveBrief } from "../sources/types.js";

// Color palette - executive minimalist
const COLORS = {
  text: "#111111",
  secondary: "#666666",
  tertiary: "#999999",
  divider: "#e0e0e0",
  background: "#ffffff",
};

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDivider(): string {
  return `<div style="border-top: 1px solid ${COLORS.divider}; margin: 24px 0;"></div>`;
}

function renderSectionDivider(): string {
  return `<div style="border-top: 1px solid ${COLORS.divider}; margin: 48px 0;"></div>`;
}

function renderLabel(text: string): string {
  return `<p style="margin: 0 0 12px 0; font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: ${COLORS.tertiary};">${escapeHtml(text)}</p>`;
}

function getSourceIndicator(source: "twitter" | "gmail"): string {
  return source === "twitter" ? "X" : "Email";
}

function renderItem(item: SummarizedItem, index: number): string {
  const link = item.url
    ? `<a href="${escapeHtml(item.url)}" style="color: ${COLORS.text}; text-decoration: underline;">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);

  const sourceIndicator = getSourceIndicator(item.source);
  const topics = item.topics.length > 0 ? item.topics.join(", ") : "";

  const takeaways =
    item.keyTakeaways.length > 0
      ? `<div style="margin: 12px 0 0 0; color: ${COLORS.secondary}; font-size: 14px; line-height: 1.6;">
        ${item.keyTakeaways.map((t) => `<div style="margin: 6px 0;">— ${escapeHtml(t)}</div>`).join("")}
      </div>`
      : "";

  return `
    <div style="margin-bottom: 24px;">
      <h3 style="margin: 0 0 8px 0; font-size: 15px; font-weight: 600; color: ${COLORS.text}; line-height: 1.4;">
        ${index + 1}. ${link}
      </h3>
      <p style="margin: 0; color: ${COLORS.secondary}; font-size: 14px; line-height: 1.6;">
        ${escapeHtml(item.summary)}
      </p>
      ${takeaways}
      <p style="margin: 10px 0 0 0; font-size: 12px; color: ${COLORS.tertiary};">
        ${sourceIndicator}${topics ? ` · ${escapeHtml(topics)}` : ""}
      </p>
    </div>
  `;
}

function renderExecutiveBrief(brief: ExecutiveBrief): string {
  return `
    <div style="margin-bottom: 48px;">
      ${renderLabel("Today's Headline")}
      <p style="margin: 0 0 24px 0; font-size: 20px; font-weight: 700; color: ${COLORS.text}; line-height: 1.3;">
        ${escapeHtml(brief.headline)}
      </p>

      ${renderDivider()}

      ${renderLabel("Strategic Insights")}
      <div style="margin: 0 0 24px 0; color: ${COLORS.text}; font-size: 14px; line-height: 1.6;">
        ${brief.strategicInsights.map((i) => `<div style="margin: 8px 0;">— ${escapeHtml(i)}</div>`).join("")}
      </div>

      ${renderLabel("Watch List")}
      <div style="color: ${COLORS.secondary}; font-size: 14px; line-height: 1.6;">
        ${brief.watchList.map((w) => `<div style="margin: 6px 0;">— ${escapeHtml(w)}</div>`).join("")}
      </div>
    </div>
  `;
}

function renderTheme(theme: ThemeSummary, index: number): string {
  const keyPointsHtml =
    theme.keyPoints.length > 0
      ? `<div style="margin: 16px 0 0 0; color: ${COLORS.secondary}; font-size: 14px; line-height: 1.6;">
        ${renderLabel("Key Points")}
        ${theme.keyPoints.map((p) => `<div style="margin: 6px 0;">— ${escapeHtml(p)}</div>`).join("")}
      </div>`
      : "";

  const sourcesHtml =
    theme.contributingSources.length > 0
      ? `<div style="margin-top: 16px;">
        ${theme.contributingSources
          .map(
            (src) =>
              `<div style="margin-bottom: 12px;">
            <p style="margin: 0; font-size: 13px; font-style: italic; color: ${COLORS.secondary};">
              "${escapeHtml(src.snippet)}"
            </p>
            <p style="margin: 4px 0 0 0; font-size: 12px; color: ${COLORS.tertiary};">
              — ${src.url ? `<a href="${escapeHtml(src.url)}" style="color: ${COLORS.tertiary}; text-decoration: underline;">${escapeHtml(src.author)}</a>` : escapeHtml(src.author)}
            </p>
          </div>`
          )
          .join("")}
      </div>`
      : "";

  return `
    <div style="margin-bottom: 32px;">
      <h3 style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; color: ${COLORS.text};">
        ${index + 1}. ${escapeHtml(theme.theme)}
      </h3>
      <p style="margin: 0; color: ${COLORS.secondary}; font-size: 14px; line-height: 1.6;">
        ${escapeHtml(theme.summary)}
      </p>
      ${keyPointsHtml}
      ${sourcesHtml}
    </div>
  `;
}

export function renderDigestHtml(digest: Digest): string {
  const dateStr = formatDate(digest.generatedAt);

  // CAIO Brief section
  const caioBriefHtml = digest.executiveBrief
    ? renderExecutiveBrief(digest.executiveBrief)
    : "";

  // Executive Summary
  const executiveSummaryHtml = `
    <div style="margin-bottom: 48px;">
      ${renderLabel("Summary")}
      <p style="margin: 0; font-size: 14px; line-height: 1.7; color: ${COLORS.text};">
        ${escapeHtml(digest.executiveSummary)}
      </p>
    </div>
  `;

  // Featured section (from bookmarks)
  const featuredHtml =
    digest.featured.length > 0
      ? `
    <div style="margin-bottom: 48px;">
      ${renderLabel("Featured")}
      ${digest.featured.map((item, i) => renderItem(item, i)).join("")}
    </div>
  `
      : "";

  // AI Community Pulse (from account themes)
  const themesHtml =
    digest.accountThemes.length > 0
      ? `
    <div style="margin-bottom: 48px;">
      ${renderLabel("Community Pulse")}
      ${digest.accountThemes.map((theme, i) => renderTheme(theme, i)).join("")}
    </div>
  `
      : "";

  // Top Stories
  const topStoriesHtml =
    digest.topStories.length > 0
      ? `
    <div style="margin-bottom: 48px;">
      ${renderLabel("Top Stories")}
      ${digest.topStories.map((item, i) => renderItem(item, i)).join("")}
    </div>
  `
      : "";

  // Topic Sections
  const sectionsHtml = digest.sections
    .map(
      (section) => `
      <div style="margin-bottom: 48px;">
        ${renderLabel(section.topic)}
        ${section.items.map((item, i) => renderItem(item, i)).join("")}
      </div>
    `
    )
    .join("");

  // Footer stats
  const totalSources = digest.sourceStats.twitterCount + digest.sourceStats.gmailCount;
  const generatedTime = digest.generatedAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Intelligence Brief - ${dateStr}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: ${COLORS.background}; color: ${COLORS.text};">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header -->
    <div style="margin-bottom: 48px;">
      <h1 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; color: ${COLORS.text};">
        AI Intelligence Brief
      </h1>
      <p style="margin: 0; color: ${COLORS.tertiary}; font-size: 13px;">
        ${dateStr}
      </p>
    </div>

    <!-- CAIO Brief -->
    ${caioBriefHtml}

    <!-- Executive Summary -->
    ${executiveSummaryHtml}

    ${renderSectionDivider()}

    <!-- Featured (from bookmarks) -->
    ${featuredHtml}

    <!-- AI Community Pulse (from themes) -->
    ${themesHtml}

    <!-- Top Stories -->
    ${topStoriesHtml}

    <!-- Topic Sections (newsletters) -->
    ${sectionsHtml}

    <!-- Footer -->
    <div style="border-top: 1px solid ${COLORS.divider}; padding-top: 24px; margin-top: 48px;">
      <p style="margin: 0; font-size: 12px; color: ${COLORS.tertiary};">
        ${totalSources} sources processed · Generated ${generatedTime}
      </p>
    </div>

  </div>
</body>
</html>
  `;
}

export function renderDigestSubject(digest: Digest): string {
  const dateStr = formatShortDate(digest.generatedAt);
  const headline = digest.executiveBrief?.headline || digest.topStories[0]?.title || "Your daily briefing";
  const truncatedHeadline = headline.length > 50 ? headline.slice(0, 50) + "..." : headline;
  return `Intelligence Brief · ${dateStr} — ${truncatedHeadline}`;
}
