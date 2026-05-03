import { loadEnv } from "./load-env.mjs";
import { publishApproved } from "./publisher.mjs";

await loadEnv();

const accessToken = process.env.X_USER_ACCESS_TOKEN;
const dryRun = process.env.DRY_RUN !== "false";

const results = await publishApproved({ accessToken, dryRun });

if (results.length === 0) {
  console.log("No approved items to publish.");
  process.exit(0);
}

for (const result of results) {
  if (result.status === "dry-run") {
    console.log(`[dry-run] Would publish ${result.type}: ${result.id}`);
  } else if (result.status === "published") {
    console.log(`Published ${result.id}: ${result.xPostId}`);
  } else {
    console.error(`Failed ${result.id}: ${result.error}`);
  }
}
