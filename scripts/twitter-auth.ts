/**
 * One-time OAuth 2.0 PKCE setup script for Twitter/X API Bookmarks
 *
 * Prerequisites:
 * 1. Go to https://developer.x.com/en/portal/dashboard
 * 2. Select your app → "User authentication settings" → Set up
 * 3. Enable OAuth 2.0
 * 4. Set Type of App: "Native App" (for PKCE without client secret)
 * 5. Set Callback URL: http://localhost
 * 6. Copy your Client ID
 *
 * Run: npm run twitter-auth
 */

import { TwitterApi } from "twitter-api-v2";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN_PATH = join(__dirname, "../twitter-token.json");
const PENDING_AUTH_PATH = join(__dirname, "../twitter-auth-pending.json");
const CALLBACK_URL = "http://localhost";

// Scopes required for bookmarks
const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

/**
 * Read a full line from stdin using raw mode to handle long pastes.
 *
 * Terminal emulators inject newlines when a pasted string wraps past the
 * terminal width. readline interprets those as Enter, truncating the input.
 * Instead, we read raw bytes and only treat a bare \n / \r (not preceded by
 * other data in the same chunk) as the real "submit".
 */
function readFullLine(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    const chunks: Buffer[] = [];
    const stdin = process.stdin;

    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    const onData = (chunk: Buffer) => {
      // Check for Ctrl-C (0x03)
      if (chunk.includes(0x03)) {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }

      // Check for Enter (\r or \n) — submit
      const enterIdx = indexOfEnter(chunk);
      if (enterIdx !== -1) {
        // Take everything before Enter from this chunk
        if (enterIdx > 0) {
          chunks.push(chunk.subarray(0, enterIdx));
        }
        cleanup();
        process.stdout.write("\n");
        const full = Buffer.concat(chunks).toString("utf-8");
        // Strip any embedded newlines/carriage returns from wrapped pastes
        resolve(full.replace(/[\r\n]/g, "").trim());
        return;
      }

      // Accumulate — echo printable characters
      chunks.push(chunk);
      const str = chunk.toString("utf-8");
      // Echo only printable chars (skip control chars from paste wrapping)
      const printable = str.replace(/[\r\n]/g, "");
      if (printable) {
        process.stdout.write(printable);
      }
    };

    function cleanup() {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw ?? false);
      }
      stdin.pause();
    }

    stdin.on("data", onData);
  });
}

/** Find the index of a bare Enter (\r or \n) in a buffer. */
function indexOfEnter(buf: Buffer): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a || buf[i] === 0x0d) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse an auth code from user input.
 * Accepts either a full redirect URL or a bare code string.
 */
function parseCodeFromInput(input: string): string {
  // Strip whitespace, newlines, surrounding quotes
  const cleaned = input.replace(/[\r\n\s]/g, "").replace(/^['"]|['"]$/g, "");

  if (!cleaned) {
    throw new Error("Empty input — no code found.");
  }

  // If it looks like a URL, extract the code param
  if (cleaned.startsWith("http")) {
    try {
      const urlObj = new URL(cleaned);
      const code = urlObj.searchParams.get("code");
      if (!code) {
        throw new Error(
          "URL has no 'code' query parameter. Make sure you copied the full redirect URL."
        );
      }
      return code;
    } catch (e: any) {
      if (e.message.includes("code")) throw e;
      throw new Error(`Could not parse URL: ${e.message}`);
    }
  }

  // Otherwise treat as bare code
  return cleaned;
}

/** Simple prompt using readline (for short inputs like Client ID). */
async function prompt(question: string): Promise<string> {
  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("Twitter/X OAuth 2.0 Setup for Bookmarks\n");

  const args = process.argv.slice(2);

  // --complete backward compat: extract the URL/code from args and fall through
  let prefilledInput: string | undefined;
  if (args[0] === "--complete" || args[0] === "-c") {
    prefilledInput = args[1];
  }

  // 1. Check for existing valid token
  if (existsSync(TOKEN_PATH)) {
    try {
      const tokens = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
      const client = new TwitterApi(tokens.accessToken);
      const me = await client.v2.me();
      console.log(`Already authenticated as: @${me.data.username}`);
      console.log("Delete twitter-token.json and re-run to re-authenticate.");
      return;
    } catch {
      console.log("Existing token is invalid. Re-authenticating.\n");
    }
  }

  // 2. If --complete was passed with a code/URL, we can skip to exchange.
  //    But we still need codeVerifier — check pending file first.
  if (prefilledInput && existsSync(PENDING_AUTH_PATH)) {
    const pending = JSON.parse(readFileSync(PENDING_AUTH_PATH, "utf-8"));
    const code = parseCodeFromInput(prefilledInput);
    await exchangeAndSave(code, pending.codeVerifier, pending.clientId);
    return;
  }

  // 3. Get Client ID
  const clientId =
    (args[0] !== "--complete" && args[0] !== "-c" ? args[0] : undefined) ||
    process.env.TWITTER_CLIENT_ID ||
    (await prompt("Enter your Twitter Client ID: "));

  if (!clientId) {
    console.error("\nError: Client ID is required.");
    console.log("\nTo get your Client ID:");
    console.log("1. Go to https://developer.x.com/en/portal/dashboard");
    console.log(
      "2. Select your app → 'User authentication settings' → Set up"
    );
    console.log(
      "3. Enable OAuth 2.0, set Type: 'Native App', Callback: 'http://localhost'"
    );
    console.log("4. Save and copy your Client ID");
    process.exit(1);
  }

  // 4. Generate auth URL (codeVerifier stays in memory — no file needed)
  const client = new TwitterApi({ clientId });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
    CALLBACK_URL,
    { scope: SCOPES }
  );

  console.log("1. Visit this URL to authorize the application:\n");
  console.log(url);
  console.log(
    "\n2. After authorizing, you'll be redirected to localhost (which will fail)."
  );
  console.log("   Copy the ENTIRE URL from your browser's address bar.\n");
  console.log(
    "3. Paste it below (the full URL or just the code value).\n"
  );

  // 5. Wait for input — raw mode to handle long paste without truncation
  const input = await readFullLine("Paste URL or code: ");

  // 6. Parse and exchange
  const code = parseCodeFromInput(input);
  await exchangeAndSave(code, codeVerifier, clientId);
}

async function exchangeAndSave(
  code: string,
  codeVerifier: string,
  clientId: string
) {
  const client = new TwitterApi({ clientId });

  try {
    const { accessToken, refreshToken, expiresIn } =
      await client.loginWithOAuth2({
        code,
        codeVerifier,
        redirectUri: CALLBACK_URL,
      });

    // Save tokens
    const tokenData = {
      accessToken,
      refreshToken,
      expiresIn,
      createdAt: new Date().toISOString(),
      clientId,
    };
    writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
    console.log("\nTokens saved to:", TOKEN_PATH);

    // Verify
    const loggedClient = new TwitterApi(accessToken);
    const me = await loggedClient.v2.me();
    console.log(`\nAuthenticated as: @${me.data.username}`);
    console.log("Twitter API is now configured for bookmarks!");

    // Clean up legacy pending file
    if (existsSync(PENDING_AUTH_PATH)) {
      unlinkSync(PENDING_AUTH_PATH);
    }
  } catch (error: any) {
    console.error("\nError exchanging code for tokens:", error.message);
    if (error.data) {
      console.error("Details:", JSON.stringify(error.data, null, 2));
    }
    process.exit(1);
  }
}

main();
