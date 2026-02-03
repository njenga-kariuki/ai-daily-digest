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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOKEN_PATH = join(__dirname, "../twitter-token.json");
const PENDING_AUTH_PATH = join(__dirname, "../twitter-auth-pending.json");
const CALLBACK_URL = "http://localhost";

// Scopes required for bookmarks
const SCOPES = ["tweet.read", "users.read", "bookmark.read", "offline.access"];

interface PendingAuth {
  codeVerifier: string;
  state: string;
  clientId: string;
  createdAt: string;
}

async function prompt(question: string): Promise<string> {
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

  // Check if we're completing a pending auth (step 2)
  if (args[0] === "--complete" || args[0] === "-c") {
    await completeAuth(args[1]);
    return;
  }

  if (existsSync(TOKEN_PATH)) {
    console.log("Token already exists at:", TOKEN_PATH);
    console.log("Delete twitter-token.json and re-run if you need to re-authenticate.\n");

    // Test the existing token
    try {
      const tokens = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
      const client = new TwitterApi(tokens.accessToken);
      const me = await client.v2.me();
      console.log(`Authenticated as: @${me.data.username}`);
      return;
    } catch (error: any) {
      console.log("Existing token is invalid. Let's re-authenticate.\n");
    }
  }

  // Get Client ID from user or args
  const clientId = args[0] || process.env.TWITTER_CLIENT_ID || await prompt("Enter your Twitter Client ID: ");

  if (!clientId) {
    console.error("\nError: Client ID is required.");
    console.log("\nTo get your Client ID:");
    console.log("1. Go to https://developer.x.com/en/portal/dashboard");
    console.log("2. Select your app → 'User authentication settings' → Set up");
    console.log("3. Enable OAuth 2.0, set Type: 'Native App', Callback: 'http://localhost'");
    console.log("4. Save and copy your Client ID");
    process.exit(1);
  }

  // Create client and generate auth URL
  const client = new TwitterApi({ clientId });

  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(
    CALLBACK_URL,
    { scope: SCOPES }
  );

  // Save pending auth for step 2
  const pendingAuth: PendingAuth = {
    codeVerifier,
    state,
    clientId,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(PENDING_AUTH_PATH, JSON.stringify(pendingAuth, null, 2));

  console.log("1. Visit this URL to authorize the application:\n");
  console.log(url);
  console.log("\n2. After authorizing, you'll be redirected to localhost (which will fail).");
  console.log("   Copy the ENTIRE URL from your browser's address bar.\n");
  console.log("3. Run: npm run twitter-auth -- --complete 'PASTE_URL_HERE'\n");
}

async function completeAuth(redirectUrl?: string) {
  if (!existsSync(PENDING_AUTH_PATH)) {
    console.error("No pending auth found. Run 'npm run twitter-auth' first to start the flow.");
    process.exit(1);
  }

  const pendingAuth: PendingAuth = JSON.parse(readFileSync(PENDING_AUTH_PATH, "utf-8"));

  if (!redirectUrl) {
    redirectUrl = await prompt("Paste the redirect URL here: ");
  }

  // Parse the code from the redirect URL
  let code: string;
  try {
    const urlObj = new URL(redirectUrl);
    code = urlObj.searchParams.get("code") || "";
    const returnedState = urlObj.searchParams.get("state");

    if (!code) {
      throw new Error("No code found in URL");
    }

    if (returnedState !== pendingAuth.state) {
      console.warn("Warning: State mismatch. This code may be from a different auth session.");
    }
  } catch (error) {
    console.error("\nError parsing redirect URL. Make sure you copied the entire URL.");
    process.exit(1);
  }

  // Exchange code for tokens
  const client = new TwitterApi({ clientId: pendingAuth.clientId });

  try {
    const { accessToken, refreshToken, expiresIn } = await client.loginWithOAuth2({
      code,
      codeVerifier: pendingAuth.codeVerifier,
      redirectUri: CALLBACK_URL,
    });

    // Save tokens
    const tokenData = {
      accessToken,
      refreshToken,
      expiresIn,
      createdAt: new Date().toISOString(),
      clientId: pendingAuth.clientId,
    };

    writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));

    // Clean up pending auth
    if (existsSync(PENDING_AUTH_PATH)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(PENDING_AUTH_PATH);
    }

    console.log("\nTokens saved to:", TOKEN_PATH);

    // Verify by fetching user info
    const loggedClient = new TwitterApi(accessToken);
    const me = await loggedClient.v2.me();
    console.log(`\nAuthenticated as: @${me.data.username}`);
    console.log("\nTwitter API is now configured for bookmarks!");
  } catch (error: any) {
    console.error("\nError exchanging code for tokens:", error.message);
    if (error.data) {
      console.error("Details:", JSON.stringify(error.data, null, 2));
    }
    process.exit(1);
  }
}

main();
