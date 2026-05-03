import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const queuePath = resolve(process.env.QUEUE_PATH || "content/queue.json");

export async function readQueue() {
  await ensureQueueFile();
  const raw = await readFile(queuePath, "utf8");
  const queue = JSON.parse(raw);

  if (!Array.isArray(queue.items)) {
    throw new Error(`${queuePath} must contain an items array.`);
  }

  return queue;
}

export async function writeQueue(queue) {
  await mkdir(dirname(queuePath), { recursive: true });
  await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
}

export async function updateQueue(mutator) {
  const queue = await readQueue();
  const result = await mutator(queue);
  await writeQueue(queue);
  return result;
}

export function createQueueItem(input) {
  return {
    id: input.id || createId(input.type || "post"),
    status: input.status || "draft",
    type: input.type || "post",
    replyToPostId: input.replyToPostId || undefined,
    text: input.text || "",
    source: input.source || "manual",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createId(type) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${type}-${stamp}-${random}`;
}

async function ensureQueueFile() {
  try {
    await readFile(queuePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeQueue({ items: [] });
  }
}
