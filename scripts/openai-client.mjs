const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiModel = process.env.OPENAI_MODEL || "gpt-5-mini";
const openaiEnabled = process.env.OPENAI_ENABLED !== "false";

export function hasOpenAI() {
  return Boolean(openaiEnabled && openaiApiKey);
}

export async function createStructuredJson({ name, schema, instructions, input, maxOutputTokens = 6000 }) {
  if (!hasOpenAI()) return null;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      model: openaiModel,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      text: {
        format: {
          type: "json_schema",
          name,
          strict: true,
          schema
        }
      }
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }

  const outputText = extractOutputText(json);
  if (!outputText) throw new Error("OpenAI response did not include output text.");
  try {
    return JSON.parse(outputText);
  } catch (error) {
    const reason = json.status === "incomplete" ? json.incomplete_details?.reason || "incomplete" : "invalid_json";
    throw new Error(`OpenAI returned ${reason}. Increase max output tokens or reduce prompt size.`);
  }
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;

  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return "";
}
