import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const CONTEXT_DIR = dirname(fileURLToPath(import.meta.url));

const FALLBACK_CONTEXT = `AI leader, leading enterprise AI transformation.
Key areas: M-Pesa mobile payments platform, financial inclusion across Africa,
fraud detection, customer experience, and operational efficiency.

Add your actual job description to src/config/caio-context/job-description.md
for more specific, grounded strategic insights.`;

export function getCAIOContextString(): string {
  try {
    const files = readdirSync(CONTEXT_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();

    if (files.length === 0) {
      return FALLBACK_CONTEXT;
    }

    return files
      .map((f) => readFileSync(join(CONTEXT_DIR, f), "utf-8"))
      .join("\n\n---\n\n");
  } catch {
    return FALLBACK_CONTEXT;
  }
}
