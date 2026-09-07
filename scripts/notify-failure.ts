import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, "..");
const CREDENTIALS_PATH = join(PROJECT_ROOT, "credentials.json");
const TOKEN_PATH = join(PROJECT_ROOT, "token.json");
const SOURCES_CONFIG_PATH = join(PROJECT_ROOT, "src/config/sources.json");
const LOG_PATH = process.env.DIGEST_LOG_PATH || join(PROJECT_ROOT, "data/ai-daily-digest.log");

function getRecipient(): string {
  try {
    const config = JSON.parse(readFileSync(SOURCES_CONFIG_PATH, "utf-8"));
    const recipient = config?.output?.recipientEmail;
    if (typeof recipient === "string" && recipient.includes("@")) {
      return recipient;
    }
  } catch {
    // fall through
  }
  throw new Error("Set output.recipientEmail in src/config/sources.json before sending notifications.");
}

async function getGmailClient() {
  if (!existsSync(CREDENTIALS_PATH) || !existsSync(TOKEN_PATH)) {
    throw new Error(
      `Gmail credentials not configured: missing ${CREDENTIALS_PATH} or ${TOKEN_PATH}`
    );
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const token = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));

  const { client_secret, client_id, redirect_uris } =
    credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  oAuth2Client.setCredentials(token);
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

function getRecentLogTail(lines: number = 100): string {
  try {
    if (!existsSync(LOG_PATH)) {
      return `(log file not found at ${LOG_PATH})`;
    }
    return execFileSync("tail", ["-n", String(lines), LOG_PATH], { encoding: "utf-8" });
  } catch (err) {
    return `(could not read log: ${(err as Error).message})`;
  }
}

function createPlainTextMime(to: string, subject: string, body: string): string {
  return [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
}

async function main() {
  const reason = process.argv[2] || "All retry attempts failed";
  const date = new Date().toISOString();
  const subject = `[AI Digest] FAILED — ${date}`;
  const logTail = getRecentLogTail(100);
  const recipient = getRecipient();

  const body = [
    `The AI Daily Digest failed at ${date}.`,
    "",
    `Reason: ${reason}`,
    "",
    "Last 100 log lines:",
    "----------------------------------------",
    logTail,
    "----------------------------------------",
    "",
    `Full log: ${LOG_PATH}`,
  ].join("\n");

  const gmail = await getGmailClient();
  const mime = createPlainTextMime(recipient, subject, body);
  const encoded = Buffer.from(mime)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });

  console.log(`Failure notification sent to ${recipient}`);
}

main().catch((err) => {
  console.error("Failed to send failure notification:", err);
  process.exit(1);
});
