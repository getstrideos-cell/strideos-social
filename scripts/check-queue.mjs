import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const queuePath = resolve("content/queue.json");
const raw = await readFile(queuePath, "utf8");
const queue = JSON.parse(raw);

const counts = queue.items.reduce(
  (acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  },
  {}
);

console.log("Stride OS publishing queue");
console.log("--------------------------");
console.log(`Total: ${queue.items.length}`);
console.log(`Draft: ${counts.draft || 0}`);
console.log(`Approved: ${counts.approved || 0}`);
console.log(`Published: ${counts.published || 0}`);
console.log(`Failed: ${counts.failed || 0}`);

const approved = queue.items.filter((item) => item.status === "approved");
if (approved.length > 0) {
  console.log("");
  console.log("Approved items:");
  for (const item of approved) {
    console.log(`- ${item.id} (${item.type})`);
  }
}
