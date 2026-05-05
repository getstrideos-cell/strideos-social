import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { queuePath } from "./queue-store.mjs";

const analyticsScope = "https://www.googleapis.com/auth/analytics.readonly";
const tokenPath = resolve(process.env.GOOGLE_TOKEN_PATH || join(dirname(queuePath), "google-analytics-token.json"));

export function hasGoogleAnalyticsConfig() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && getGoogleAnalyticsPropertyId());
}

export function getGoogleAnalyticsPropertyId() {
  return process.env.GOOGLE_ANALYTICS_PROPERTY_ID || process.env.GA4_PROPERTY_ID || "";
}

export function getGoogleRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const protocol = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${req.headers.host}/auth/google/callback`;
}

export function buildGoogleAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: analyticsScope,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });
  if (process.env.GOOGLE_LOGIN_HINT) {
    params.set("login_hint", process.env.GOOGLE_LOGIN_HINT);
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode({ code, redirectUri }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google token exchange failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const tokenState = {
    accessToken: json.access_token || "",
    refreshToken: json.refresh_token || "",
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0,
    scope: json.scope || analyticsScope,
    connectedAt: new Date().toISOString()
  };
  await writeGoogleTokenState(tokenState);
  return tokenState;
}

export async function readGoogleTokenState() {
  try {
    const persisted = JSON.parse(await readFile(tokenPath, "utf8"));
    return {
      accessToken: persisted.accessToken || "",
      refreshToken: persisted.refreshToken || process.env.GOOGLE_REFRESH_TOKEN || "",
      expiresAt: Number(persisted.expiresAt || 0),
      scope: persisted.scope || "",
      connectedAt: persisted.connectedAt || "",
      refreshedAt: persisted.refreshedAt || ""
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        accessToken: "",
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",
        expiresAt: 0,
        scope: "",
        connectedAt: "",
        refreshedAt: ""
      };
    }
    throw error;
  }
}

export async function getGoogleAnalyticsStatus() {
  const token = await readGoogleTokenState();
  return {
    configured: hasGoogleAnalyticsConfig(),
    connected: Boolean(token.refreshToken),
    propertyId: getGoogleAnalyticsPropertyId(),
    connectedAt: token.connectedAt || "",
    refreshedAt: token.refreshedAt || ""
  };
}

export async function runGoogleAnalyticsReport({ metrics, dimensions = [], dateRanges = [{ startDate: "7daysAgo", endDate: "today" }], limit = 10 }) {
  const propertyId = getGoogleAnalyticsPropertyId();
  if (!hasGoogleAnalyticsConfig()) throw new Error("Google Analytics OAuth is not configured.");
  if (!propertyId) throw new Error("GOOGLE_ANALYTICS_PROPERTY_ID is required.");

  const token = await getFreshGoogleToken();
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      dateRanges,
      metrics: metrics.map((name) => ({ name })),
      dimensions: dimensions.map((name) => ({ name })),
      limit
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Analytics Data API returned ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function getFreshGoogleToken() {
  const token = await readGoogleTokenState();
  if (token.accessToken && token.expiresAt && token.expiresAt > Date.now() + 60_000) return token;
  if (!token.refreshToken) throw new Error("Google Analytics is not connected yet.");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: token.refreshToken,
      grant_type: "refresh_token"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google token refresh failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }

  const nextToken = {
    ...token,
    accessToken: json.access_token || "",
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0,
    scope: json.scope || token.scope,
    refreshedAt: new Date().toISOString()
  };
  await writeGoogleTokenState(nextToken);
  return nextToken;
}

async function writeGoogleTokenState(state) {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
