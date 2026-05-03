export function validatePublishItem(item) {
  if (!item.id) throw new Error("Approved item is missing id.");
  if (!["post", "reply"].includes(item.type)) {
    throw new Error(`${item.id} has unsupported type: ${item.type}`);
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
    throw new Error(`X API returned ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}
