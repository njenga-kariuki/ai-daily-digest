import { extractArticle } from "./sources/article-extractor.js";
import { extractGitHubContent } from "./sources/github-extractor.js";
import { extractYouTubeContent } from "./sources/youtube-extractor.js";
import { extractWithPuppeteer } from "./sources/puppeteer-fallback.js";

interface TestResult {
  name: string;
  passed: boolean;
  contentLength: number;
  hasQualityContent: boolean;
  details: string;
}

interface QualitySummary {
  youtube: { withTranscript: number; metadataOnly: number; failed: number };
  github: { withReadme: number; metadataOnly: number; failed: number };
  articles: { extracted: number; tooShort: number; failed: number };
  puppeteer: { extracted: number; tooShort: number; failed: number };
}

const QUALITY_THRESHOLDS = {
  youtube: 500, // Transcript should be substantial
  github: 200, // README content should exist
  article: 300, // Article body should have content
  puppeteer: 300,
};

async function testYouTube(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test 1: Video with captions (popular video likely to have captions)
  console.log("  Testing video with captions...");
  try {
    const result = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    if (result) {
      const hasTranscript = result.hasTranscript === true;
      results.push({
        name: "YouTube (with captions)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: hasTranscript && result.content.length > QUALITY_THRESHOLDS.youtube,
        details: hasTranscript
          ? `Transcript: ${result.content.length} chars`
          : `Metadata only: ${result.content.length} chars`,
      });
    } else {
      results.push({
        name: "YouTube (with captions)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "YouTube (with captions)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  // Test 2: YouTube Shorts (may not have captions)
  console.log("  Testing YouTube Shorts...");
  try {
    // Using a well-known short - these often don't have transcripts
    const result = await extractYouTubeContent(
      "https://www.youtube.com/shorts/dQw4w9WgXcQ"
    );
    if (result) {
      results.push({
        name: "YouTube Shorts",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: result.hasTranscript === true,
        details: result.hasTranscript
          ? `Transcript: ${result.content.length} chars`
          : `Metadata only (expected for shorts)`,
      });
    } else {
      results.push({
        name: "YouTube Shorts",
        passed: true, // Null is acceptable for shorts
        contentLength: 0,
        hasQualityContent: false,
        details: "No result (some shorts have no metadata)",
      });
    }
  } catch (e) {
    results.push({
      name: "YouTube Shorts",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  // Test 3: Tech talk (likely to have captions)
  console.log("  Testing tech conference video...");
  try {
    // Andrej Karpathy's intro to LLMs - should have captions
    const result = await extractYouTubeContent(
      "https://www.youtube.com/watch?v=zjkBMFhNj_g"
    );
    if (result) {
      results.push({
        name: "YouTube (tech talk)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: result.hasTranscript === true && result.content.length > QUALITY_THRESHOLDS.youtube,
        details: result.hasTranscript
          ? `Transcript: ${result.content.length} chars`
          : `Metadata only: ${result.content.length} chars`,
      });
    } else {
      results.push({
        name: "YouTube (tech talk)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "YouTube (tech talk)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  return results;
}

async function testGitHub(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test 1: Popular repo with README
  console.log("  Testing popular repo...");
  try {
    const result = await extractGitHubContent(
      "https://github.com/anthropics/anthropic-sdk-python"
    );
    if (result) {
      const hasReadme = result.content.includes("README") || result.content.length > QUALITY_THRESHOLDS.github;
      results.push({
        name: "GitHub (with README)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: hasReadme,
        details: `${result.content.length} chars, title: "${result.title}"`,
      });
    } else {
      results.push({
        name: "GitHub (with README)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "GitHub (with README)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  // Test 2: Repo with minimal README
  console.log("  Testing repo with minimal docs...");
  try {
    const result = await extractGitHubContent(
      "https://github.com/anthropics/anthropic-quickstarts"
    );
    if (result) {
      results.push({
        name: "GitHub (quickstarts)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: result.content.length > QUALITY_THRESHOLDS.github,
        details: `${result.content.length} chars`,
      });
    } else {
      results.push({
        name: "GitHub (quickstarts)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "GitHub (quickstarts)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  return results;
}

async function testArticles(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test 1: OpenAI blog (static site)
  console.log("  Testing static blog...");
  try {
    const result = await extractArticle("https://openai.com/index/gpt-4/");
    if (result) {
      results.push({
        name: "Article (OpenAI blog)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: result.content.length > QUALITY_THRESHOLDS.article,
        details: `${result.content.length} chars from ${result.siteName || "unknown"}`,
      });
    } else {
      results.push({
        name: "Article (OpenAI blog)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "Article (OpenAI blog)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  // Test 2: Anthropic news
  console.log("  Testing Anthropic news...");
  try {
    const result = await extractArticle("https://www.anthropic.com/news/claude-3-5-sonnet");
    if (result) {
      results.push({
        name: "Article (Anthropic)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: result.content.length > QUALITY_THRESHOLDS.article,
        details: `${result.content.length} chars`,
      });
    } else {
      results.push({
        name: "Article (Anthropic)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "Article (Anthropic)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  return results;
}

async function testPuppeteer(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test: JS-heavy site (Medium)
  console.log("  Testing JS-heavy site (Medium)...");
  try {
    const result = await extractWithPuppeteer(
      "https://medium.com/@anthropic/introducing-claude-3-5-sonnet-f084ea27ded6"
    );
    if (result) {
      results.push({
        name: "Puppeteer (Medium)",
        passed: true,
        contentLength: result.content.length,
        hasQualityContent: result.content.length > QUALITY_THRESHOLDS.puppeteer,
        details: `${result.content.length} chars`,
      });
    } else {
      results.push({
        name: "Puppeteer (Medium)",
        passed: false,
        contentLength: 0,
        hasQualityContent: false,
        details: "No result returned",
      });
    }
  } catch (e) {
    results.push({
      name: "Puppeteer (Medium)",
      passed: false,
      contentLength: 0,
      hasQualityContent: false,
      details: `Error: ${e}`,
    });
  }

  return results;
}

function computeSummary(allResults: TestResult[]): QualitySummary {
  const summary: QualitySummary = {
    youtube: { withTranscript: 0, metadataOnly: 0, failed: 0 },
    github: { withReadme: 0, metadataOnly: 0, failed: 0 },
    articles: { extracted: 0, tooShort: 0, failed: 0 },
    puppeteer: { extracted: 0, tooShort: 0, failed: 0 },
  };

  for (const result of allResults) {
    if (result.name.startsWith("YouTube")) {
      if (!result.passed) {
        summary.youtube.failed++;
      } else if (result.hasQualityContent) {
        summary.youtube.withTranscript++;
      } else {
        summary.youtube.metadataOnly++;
      }
    } else if (result.name.startsWith("GitHub")) {
      if (!result.passed) {
        summary.github.failed++;
      } else if (result.hasQualityContent) {
        summary.github.withReadme++;
      } else {
        summary.github.metadataOnly++;
      }
    } else if (result.name.startsWith("Article")) {
      if (!result.passed) {
        summary.articles.failed++;
      } else if (result.hasQualityContent) {
        summary.articles.extracted++;
      } else {
        summary.articles.tooShort++;
      }
    } else if (result.name.startsWith("Puppeteer")) {
      if (!result.passed) {
        summary.puppeteer.failed++;
      } else if (result.hasQualityContent) {
        summary.puppeteer.extracted++;
      } else {
        summary.puppeteer.tooShort++;
      }
    }
  }

  return summary;
}

function printSummary(summary: QualitySummary): void {
  console.log("\n=== Quality Summary ===\n");

  const ytTotal = summary.youtube.withTranscript + summary.youtube.metadataOnly + summary.youtube.failed;
  const ytPct = ytTotal > 0 ? Math.round((summary.youtube.withTranscript / ytTotal) * 100) : 0;
  console.log(
    `YouTube: ${summary.youtube.withTranscript}/${ytTotal} with transcripts (${ytPct}%)` +
      (summary.youtube.metadataOnly > 0 ? `, ${summary.youtube.metadataOnly} metadata-only` : "") +
      (summary.youtube.failed > 0 ? `, ${summary.youtube.failed} failed` : "")
  );

  const ghTotal = summary.github.withReadme + summary.github.metadataOnly + summary.github.failed;
  console.log(
    `GitHub: ${summary.github.withReadme}/${ghTotal} with README content` +
      (summary.github.failed > 0 ? `, ${summary.github.failed} failed` : "")
  );

  const artTotal = summary.articles.extracted + summary.articles.tooShort + summary.articles.failed;
  console.log(
    `Articles: ${summary.articles.extracted}/${artTotal} extracted successfully` +
      (summary.articles.tooShort > 0 ? `, ${summary.articles.tooShort} too short` : "") +
      (summary.articles.failed > 0 ? `, ${summary.articles.failed} failed` : "")
  );

  const pupTotal = summary.puppeteer.extracted + summary.puppeteer.tooShort + summary.puppeteer.failed;
  if (pupTotal > 0) {
    console.log(
      `Puppeteer: ${summary.puppeteer.extracted}/${pupTotal} extracted successfully` +
        (summary.puppeteer.failed > 0 ? `, ${summary.puppeteer.failed} failed` : "")
    );
  }
}

async function test() {
  console.log("=== Testing Extractors with Quality Metrics ===\n");

  const allResults: TestResult[] = [];

  // Test YouTube
  console.log("1. Testing YouTube extractor...");
  const youtubeResults = await testYouTube();
  for (const r of youtubeResults) {
    const icon = r.passed ? (r.hasQualityContent ? "✓" : "⚠") : "✗";
    console.log(`   ${icon} ${r.name}: ${r.details}`);
  }
  allResults.push(...youtubeResults);

  // Test GitHub
  console.log("\n2. Testing GitHub extractor...");
  const githubResults = await testGitHub();
  for (const r of githubResults) {
    const icon = r.passed ? (r.hasQualityContent ? "✓" : "⚠") : "✗";
    console.log(`   ${icon} ${r.name}: ${r.details}`);
  }
  allResults.push(...githubResults);

  // Test Articles
  console.log("\n3. Testing article extraction...");
  const articleResults = await testArticles();
  for (const r of articleResults) {
    const icon = r.passed ? (r.hasQualityContent ? "✓" : "⚠") : "✗";
    console.log(`   ${icon} ${r.name}: ${r.details}`);
  }
  allResults.push(...articleResults);

  // Test Puppeteer
  console.log("\n4. Testing Puppeteer fallback...");
  const puppeteerResults = await testPuppeteer();
  for (const r of puppeteerResults) {
    const icon = r.passed ? (r.hasQualityContent ? "✓" : "⚠") : "✗";
    console.log(`   ${icon} ${r.name}: ${r.details}`);
  }
  allResults.push(...puppeteerResults);

  // Print quality summary
  const summary = computeSummary(allResults);
  printSummary(summary);

  // Exit code based on critical failures
  const criticalFailures = allResults.filter(
    (r) => !r.passed && !r.name.includes("Shorts")
  ).length;
  if (criticalFailures > 0) {
    console.log(`\n⚠ ${criticalFailures} critical failure(s) detected`);
    process.exit(1);
  }

  console.log("\n=== Tests Complete ===");
}

test().catch(console.error);
