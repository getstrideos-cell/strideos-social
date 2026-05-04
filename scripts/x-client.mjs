export class XApiError extends Error {
  constructor(status, payload, message) {
    super(message);
    this.name = "XApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function validatePublishItem(item) {
  if (!item.id) throw new Error("Approved item is missing id.");
  if (!["post", "reply"].includes(item.type)) {
    throw new Error(`${item.id} has unsupported type: ${item.type}`);
  }
  if (item.requiresManualAsset || item.format === "founder-moment") {
    throw new Error(`${item.id} needs a manual image/video asset. Post it manually, then mark it as posted.`);
  }
  if (!item.text || typeof item.text !== "string") {
    throw new Error(`${item.id} is missing text.`);
  }
  if (item.text.length > 280) {
    throw new Error(`${item.id} is ${item.text.length} characters; keep posts at 280 or less.`);
  }
  if (item.type === "reply" && !item.replyToPostId) {
    throw new Error(`${item.id} is a reply but has no replyToPostId.`);
  }
  if (item.type === "reply" && item.replyToPostId === "REPLACE_WITH_X_POST_ID") {
    throw new Error(`${item.id} needs a real replyToPostId before publishing.`);
  }
}

export async function createXPost(item, token) {
  const body = {
    text: item.text
  };

  if (item.type === "reply") {
    body.reply = {
      in_reply_to_tweet_id: item.replyToPostId
    };
  }

  const response = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new XApiError(response.status, json, formatXError(response.status, json));
  }

  return json;
}

export async function refreshXAccessToken({ refreshToken, clientId, clientSecret } = {}) {
  if (!refreshToken) {
    throw new Error("X_REFRESH_TOKEN is required to refresh an expired X access token.");
  }
  if (!clientId) {
    throw new Error("X_CLIENT_ID is required to refresh an expired X access token.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded"
  };

  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
  }

  const response = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers,
    body
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new XApiError(response.status, json, formatXError(response.status, json));
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresIn: json.expires_in
  };
}

export function formatXError(status, json) {
  const title = json?.title;
  const detail = json?.detail;

  if (status === 401) {
    return "X access token is unauthorized or expired. Configure X_REFRESH_TOKEN, X_CLIENT_ID, and X_CLIENT_SECRET so the app can renew it automatically.";
  }

  if (status === 402 && title === "CreditsDepleted") {
    return "X API credits are depleted. Add credits in the X Developer dashboard before publishing more items.";
  }

  if (status === 403 && typeof detail === "string" && detail.includes("Reply to this conversation is not allowed")) {
    return "X blocked this reply because that post does not allow replies from this account. Pick another target or convert it into a normal post.";
  }

  return `X API returned ${status}: ${JSON.stringify(json)}`;
}
