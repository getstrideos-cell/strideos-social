import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const nextStatus = process.argv[2];
const id = process.argv[3];

if (!["approved", "rejected", "draft"].includes(nextStatus)) {
  throw new Error("Usage: node scripts/set-status.mjs <approved|rejected|draft> <item-id>");
}

if (!id) {
  throw new Error(`Missing item id. Example: npm run approve -- example-post-001`);
}

const queuePath = resolve("content/queue.json");
const raw = await readFile(queuePath, "utf8");
const queue = JSON.parse(raw);

const item = queue.items.find((candidate) => candidate.id === id);

if (!item) {
  throw new Error(`No queue item found with id: ${id}`);
}

if (item.status === "published") {
  throw new Error(`${id} is already published and cannot be changed.`);
}

item.status = nextStatus;
item.updatedAt = new Date().toISOString();

await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
console.log(`${id} marked as ${nextStatus}.`);
