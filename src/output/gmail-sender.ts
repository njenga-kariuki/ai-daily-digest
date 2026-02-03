import { google } from "googleapis";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import { sourcesConfig, settings } from "../config/settings.js";
import type { Digest } from "../sources/types.js";
import { renderDigestHtml, renderDigestSubject } from "./email-template.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("GmailSender");

const CREDENTIALS_PATH = join(__dirname, "../../credentials.json");
const TOKEN_PATH = join(__dirname, "../../token.json");
const UNSENT_DIR = join(__dirname, "../../data/unsent");

async function getGmailClient() {
  if (!existsSync(CREDENTIALS_PATH) || !existsSync(TOKEN_PATH)) {
    throw new Error(
      "Gmail credentials not configured. Run `npm run gmail-auth` first."
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

function createMimeMessage(
  to: string,
  subject: string,
  htmlBody: string
): string {
  const boundary = "boundary_" + Date.now().toString(16);

  const messageParts = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "This email requires HTML to view. Please enable HTML in your email client.",
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    htmlBody,
    "",
    `--${boundary}--`,
  ];

  return messageParts.join("\r\n");
}

function saveUnsentDigest(digest: Digest, htmlContent: string): void {
  if (!existsSync(UNSENT_DIR)) {
    mkdirSync(UNSENT_DIR, { recursive: true });
  }

  const filename = `${digest.id}.html`;
  const filepath = join(UNSENT_DIR, filename);
  writeFileSync(filepath, htmlContent);
  logger.warn(`Saved unsent digest to: ${filepath}`);
}

async function sendWithRetry(
  gmail: any,
  raw: string,
  maxAttempts: number = settings.retry.maxAttempts
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      return true;
    } catch (error: any) {
      logger.warn(`Send attempt ${attempt} failed`, error.message);

      if (attempt < maxAttempts) {
        const delay = settings.retry.delayMs * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  return false;
}

export async function sendDigestEmail(digest: Digest): Promise<boolean> {
  logger.info("Sending digest email");

  const recipient = sourcesConfig.output.recipientEmail;
  const subject = renderDigestSubject(digest);
  const htmlContent = renderDigestHtml(digest);

  try {
    const gmail = await getGmailClient();
    const mimeMessage = createMimeMessage(recipient, subject, htmlContent);
    const encodedMessage = Buffer.from(mimeMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const success = await sendWithRetry(gmail, encodedMessage);

    if (success) {
      logger.info(`Digest email sent to ${recipient}`);
      return true;
    } else {
      saveUnsentDigest(digest, htmlContent);
      return false;
    }
  } catch (error) {
    logger.error("Failed to send digest email", error);
    saveUnsentDigest(digest, htmlContent);
    return false;
  }
}
