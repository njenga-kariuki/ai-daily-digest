import { google } from "googleapis";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import { sourcesConfig } from "../config/settings.js";
import type { GmailNewsletter } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger("Gmail");

const CREDENTIALS_PATH = join(__dirname, "../../credentials.json");
const TOKEN_PATH = join(__dirname, "../../token.json");

function cleanUrl(url: string): string {
  // Strip trailing punctuation that's commonly appended in text
  return url.replace(/[)}\],;:!?.—–]+$/, '');
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const matches = text.match(urlRegex) || [];
  // Clean URLs and filter out tracking/unsubscribe/image URLs
  return matches
    .map(cleanUrl)
    .filter(
      (url) =>
        !url.includes("unsubscribe") &&
        !url.includes("tracking") &&
        !url.includes("click.") &&
        !url.includes("list-manage.com") &&
        !url.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i) &&
        !url.includes("/cdn-cgi/image/")
    );
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractBody(payload: any): string {
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Fallback to HTML if no plain text
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data);
        // Basic HTML to text conversion
        return html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
    // Recursive check for nested parts
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

async function getGmailClient() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      "Gmail credentials not found. Run `npm run gmail-auth` to set up authentication."
    );
  }

  if (!existsSync(TOKEN_PATH)) {
    throw new Error(
      "Gmail token not found. Run `npm run gmail-auth` to authenticate."
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

export async function fetchNewsletters(): Promise<GmailNewsletter[]> {
  logger.info("Fetching newsletters from Gmail");

  const gmail = await getGmailClient();
  const { newsletterLabel, lookbackHours } = sourcesConfig.gmail;

  // Calculate time filter
  const afterDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const afterTimestamp = Math.floor(afterDate.getTime() / 1000);

  // Build query
  const query = `label:${newsletterLabel.replace("/", "-")} after:${afterTimestamp}`;
  logger.debug("Gmail query", query);

  try {
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 50,
    });

    const messages = listResponse.data.messages || [];
    logger.info(`Found ${messages.length} newsletters`);

    const newsletters: GmailNewsletter[] = [];

    for (const msg of messages) {
      try {
        const fullMessage = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "full",
        });

        const headers = fullMessage.data.payload?.headers || [];
        const subject =
          headers.find((h) => h.name === "Subject")?.value || "No Subject";
        const from = headers.find((h) => h.name === "From")?.value || "Unknown";
        const dateStr =
          headers.find((h) => h.name === "Date")?.value || new Date().toISOString();

        const body = extractBody(fullMessage.data.payload);
        const urls = extractUrls(body);

        newsletters.push({
          id: msg.id!,
          subject,
          from,
          body,
          receivedAt: new Date(dateStr),
          urls,
        });
      } catch (err) {
        logger.warn(`Failed to fetch message ${msg.id}`, err);
      }
    }

    return newsletters;
  } catch (error) {
    logger.error("Failed to fetch newsletters", error);
    throw error;
  }
}
