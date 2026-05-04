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

  if (normalizeLegacyStatuses(queue)) {
    await writeQueue(queue);
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
    format: input.format || "standard",
    title: input.title || undefined,
    replyToPostId: input.replyToPostId || undefined,
    targetAuthor: input.targetAuthor || undefined,
    targetHandle: input.targetHandle || undefined,
    targetPostUrl: input.targetPostUrl || undefined,
    targetPostText: input.targetPostText || undefined,
    targetPostSummary: input.targetPostSummary || undefined,
    replyRationale: input.replyRationale || undefined,
    recommendedSurface: input.recommendedSurface || undefined,
    viralThesis: input.viralThesis || undefined,
    evidence: input.evidence || undefined,
    sourceUrl: input.sourceUrl || undefined,
    trendSignal: input.trendSignal || undefined,
    whyNow: input.whyNow || undefined,
    visualBrief: input.visualBrief || undefined,
    captureInstruction: input.captureInstruction || undefined,
    postingNotes: input.postingNotes || undefined,
    imageAlt: input.imageAlt || undefined,
    requiresManualAsset: Boolean(input.requiresManualAsset),
    requiresManualPublish: Boolean(input.requiresManualPublish),
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

function normalizeLegacyStatuses(queue) {
  let changed = false;

  for (const item of queue.items) {
    if (item.status === "approve") {
      item.status = "draft";
      item.legacyStatus = "approve";
      item.updatedAt = new Date().toISOString();
      changed = true;
    }

    if (item.status === "published" && item.xPostId && item.error) {
      delete item.error;
      delete item.failedAt;
      item.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  return changed;
}
