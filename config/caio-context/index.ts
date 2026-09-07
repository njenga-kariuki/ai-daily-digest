import { readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const CONTEXT_DIR = dirname(fileURLToPath(import.meta.url));

const FALLBACK_CONTEXT = `AI leader evaluating research, product opportunities, and enterprise adoption.
Key areas: model capabilities, practical deployment, economics, governance,
and the implications of AI for teams and customers.

Add your actual job description to config/caio-context/job-description.md
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
