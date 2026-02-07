import type {
  Digest,
  SummarizedItem,
  SynthesizedTheme,
  ExecutiveBrief,
} from "../sources/types.js";

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

function renderSectionDivider(): string {
  return `<div style="border-top: 1px solid ${COLORS.divider}; margin: 48px 0;"></div>`;
}

function renderDivider(): string {
  return `<div style="border-top: 1px solid ${COLORS.divider}; margin: 24px 0;"></div>`;
}

function renderLabel(text: string): string {
  return `<p style="margin: 0 0 12px 0; font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: ${COLORS.tertiary};">${escapeHtml(text)}</p>`;
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

function renderSynthesizedTheme(
  theme: SynthesizedTheme,
  index: number
): string {
  const insightsHtml =
    theme.keyInsights.length > 0
      ? `<div style="margin: 16px 0 0 0; color: ${COLORS.secondary}; font-size: 14px; line-height: 1.6;">
        ${renderLabel("Key Insights")}
        ${theme.keyInsights.map((p) => `<div style="margin: 6px 0;">— ${escapeHtml(p)}</div>`).join("")}
      </div>`
      : "";

  const sourcesHtml =
    theme.sources.length > 0
      ? `<div style="margin-top: 16px;">
        ${theme.sources
          .map(
            (src) =>
              `<div style="margin-bottom: 10px;">
            <p style="margin: 0; font-size: 13px; font-style: italic; color: ${COLORS.secondary};">
              "${escapeHtml(src.snippet)}"
            </p>
            <p style="margin: 4px 0 0 0; font-size: 12px; color: ${COLORS.tertiary};">
              — ${src.url ? `<a href="${escapeHtml(src.url)}" style="color: ${COLORS.tertiary}; text-decoration: underline;">${escapeHtml(src.author)}</a>` : escapeHtml(src.author)}
              <span style="margin-left: 6px; font-size: 11px;">${escapeHtml(src.sourceType)}</span>
            </p>
          </div>`
          )
          .join("")}
      </div>`
      : "";

  return `
    <div style="margin-bottom: 36px;">
      <h3 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: ${COLORS.text};">
        ${index + 1}. ${escapeHtml(theme.theme)}
      </h3>
      <p style="margin: 0; color: ${COLORS.text}; font-size: 14px; line-height: 1.7;">
        ${escapeHtml(theme.narrative)}
      </p>
      ${insightsHtml}
      ${sourcesHtml}
    </div>
  `;
}

function getSourceTag(item: SummarizedItem): string {
  if (item.source === "gmail") {
    return item.newsletterName || "Newsletter";
  }
  if (item.twitterSourceType === "account") {
    return "Community";
  }
  return "Bookmark";
}

function renderSourceIndex(items: SummarizedItem[]): string {
  // Group by source type
  const bookmarks = items.filter(
    (i) => i.source === "twitter" && i.twitterSourceType !== "account"
  );
  const newsletters = items.filter((i) => i.source === "gmail");
  const community = items.filter(
    (i) => i.source === "twitter" && i.twitterSourceType === "account"
  );

  function renderGroup(
    label: string,
    groupItems: SummarizedItem[]
  ): string {
    if (groupItems.length === 0) return "";

    const itemsHtml = groupItems
      .map((item) => {
        const title = item.url
          ? `<a href="${escapeHtml(item.url)}" style="color: ${COLORS.text}; text-decoration: underline; font-weight: 500;">${escapeHtml(item.title)}</a>`
          : `<span style="font-weight: 500;">${escapeHtml(item.title)}</span>`;

        const tag = getSourceTag(item);

        return `<div style="margin-bottom: 12px;">
          <div style="font-size: 14px; line-height: 1.4;">${title}</div>
          <div style="font-size: 13px; color: ${COLORS.secondary}; margin-top: 2px;">${escapeHtml(item.summary.split(".")[0])}.</div>
          <div style="font-size: 11px; color: ${COLORS.tertiary}; margin-top: 2px;">${escapeHtml(tag)}</div>
        </div>`;
      })
      .join("");

    return `
      <div style="margin-bottom: 24px;">
        ${renderLabel(label)}
        ${itemsHtml}
      </div>
    `;
  }

  return `
    <div style="margin-bottom: 48px;">
      ${renderGroup("Bookmarks", bookmarks)}
      ${renderGroup("Newsletters", newsletters)}
      ${renderGroup("Community", community)}
    </div>
  `;
}

export function renderDigestHtml(digest: Digest): string {
  const dateStr = formatDate(digest.generatedAt);

  // CAIO Brief section
  const caioBriefHtml = digest.executiveBrief
    ? renderExecutiveBrief(digest.executiveBrief)
    : "";

  // Synthesized Themes
  const themesHtml =
    digest.themes.length > 0
      ? `
    <div style="margin-bottom: 48px;">
      ${digest.themes.map((theme, i) => renderSynthesizedTheme(theme, i)).join("")}
    </div>
  `
      : "";

  // Source Index
  const sourceIndexHtml =
    digest.allItems.length > 0 ? renderSourceIndex(digest.allItems) : "";

  // Footer stats
  const totalSources =
    digest.sourceStats.twitterCount + digest.sourceStats.gmailCount;
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

    <!-- CAIO Strategic Brief -->
    ${caioBriefHtml}

    ${caioBriefHtml ? renderSectionDivider() : ""}

    <!-- Synthesized Themes -->
    ${themesHtml}

    ${themesHtml ? renderSectionDivider() : ""}

    <!-- Source Index -->
    ${sourceIndexHtml}

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
  const headline =
    digest.executiveBrief?.headline ||
    digest.themes[0]?.theme ||
    "Your daily briefing";
  const truncatedHeadline =
    headline.length > 50 ? headline.slice(0, 50) + "..." : headline;
  return `Intelligence Brief · ${dateStr} — ${truncatedHeadline}`;
}
