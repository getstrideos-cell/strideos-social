import { updateQueue } from "./queue-store.mjs";
import { createXPost, validatePublishItem } from "./x-client.mjs";

export async function publishApproved({ accessToken, dryRun = true, onlyId } = {}) {
  const results = [];

  await updateQueue(async (queue) => {
    const approvedItems = queue.items.filter((item) => {
      if (item.status !== "approved") return false;
      if (onlyId && item.id !== onlyId) return false;
      return true;
    });

    if (approvedItems.length === 0) return;

    if (!dryRun && !accessToken) {
      throw new Error("X_USER_ACCESS_TOKEN is required when DRY_RUN=false.");
    }

    for (const item of approvedItems) {
      try {
        validatePublishItem(item);

        if (dryRun) {
          results.push({ id: item.id, type: item.type, status: "dry-run" });
          continue;
        }

        const response = await createXPost(item, accessToken);
        item.status = "published";
        item.publishedAt = new Date().toISOString();
        item.updatedAt = new Date().toISOString();
        item.xPostId = response.data.id;
        item.xResponse = response;
        delete item.error;
        delete item.failedAt;
        results.push({ id: item.id, type: item.type, status: "published", xPostId: response.data.id });
      } catch (error) {
        item.status = "failed";
        item.failedAt = new Date().toISOString();
        item.updatedAt = new Date().toISOString();
        item.error = error instanceof Error ? error.message : String(error);
        results.push({ id: item.id, type: item.type, status: "failed", error: item.error });
      }
    }
  });

  return results;
}
