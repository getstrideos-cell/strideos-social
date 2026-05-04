import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const queuePath = resolve(process.env.QUEUE_PATH || "content/queue.json");
export const tokenPath = resolve(process.env.X_TOKEN_PATH || join(dirname(queuePath), "x-token.json"));

export async function readXTokenState() {
  const persisted = await readPersistedTokenState();

  return {
    accessToken: persisted.accessToken || process.env.X_USER_ACCESS_TOKEN || "",
    refreshToken: persisted.refreshToken || process.env.X_REFRESH_TOKEN || "",
    refreshedAt: persisted.refreshedAt || ""
  };
}

export async function writeXTokenState(state) {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function readPersistedTokenState() {
  try {
    return JSON.parse(await readFile(tokenPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
