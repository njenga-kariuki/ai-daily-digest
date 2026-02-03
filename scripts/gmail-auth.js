/**
 * One-time OAuth setup script for Gmail API
 *
 * Prerequisites:
 * 1. Create a Google Cloud project at https://console.cloud.google.com
 * 2. Enable the Gmail API
 * 3. Create OAuth 2.0 credentials (Desktop app)
 * 4. Download credentials and save as credentials.json in project root
 *
 * Run: npm run gmail-auth
 */
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
];
const CREDENTIALS_PATH = join(__dirname, "../credentials.json");
const TOKEN_PATH = join(__dirname, "../token.json");
async function getAuthUrl() {
    if (!existsSync(CREDENTIALS_PATH)) {
        console.error("Error: credentials.json not found. Please download OAuth credentials from Google Cloud Console.");
        process.exit(1);
    }
    const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
    });
    return { oAuth2Client, authUrl };
}
async function promptForCode() {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question("Enter the authorization code: ", (code) => {
            rl.close();
            resolve(code.trim());
        });
    });
}
async function main() {
    console.log("Gmail OAuth Setup\n");
    if (existsSync(TOKEN_PATH)) {
        console.log("Token already exists at:", TOKEN_PATH);
        console.log("Delete token.json and re-run if you need to re-authenticate.");
        return;
    }
    const { oAuth2Client, authUrl } = await getAuthUrl();
    console.log("1. Visit this URL to authorize the application:\n");
    console.log(authUrl);
    console.log("\n2. After authorizing, you'll get a code. Paste it below.\n");
    const code = await promptForCode();
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log("\nToken saved to:", TOKEN_PATH);
        console.log("Gmail API is now configured!");
    }
    catch (error) {
        console.error("Error retrieving access token:", error);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=gmail-auth.js.map