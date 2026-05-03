import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const apiKey = (await readSecret(".render-api-key")).trim();

if (!apiKey) {
  throw new Error("Missing .render-api-key. Create a Render API key and paste it into that local file.");
}

const adminPassword = (await readSecret(".render-admin-password")).trim() || randomSecret(18);
const sessionSecret = randomSecret(48);
const apiToken = randomSecret(32);

const repo = "https://github.com/getstrideos-cell/strideos-social";
const serviceName = "strideos-social";
const apiBase = "https://api.render.com/v1";

const owners = await renderFetch("/owners?limit=20");
const owner = owners.find((entry) => entry.owner?.type === "user")?.owner || owners[0]?.owner;

if (!owner?.id) {
  throw new Error(`Could not find a Render workspace. Response: ${JSON.stringify(owners)}`);
}

const existingServices = await renderFetch(`/services?name=${encodeURIComponent(serviceName)}&limit=20`);
const existing = existingServices.find((entry) => entry.service?.name === serviceName)?.service;

if (existing) {
  console.log(`Render service already exists: ${existing.name} (${existing.id})`);
  console.log(existing.serviceDetails?.url || existing.dashboardUrl || "");
  process.exit(0);
}

const payload = {
  type: "web_service",
  name: serviceName,
  ownerId: owner.id,
  repo,
  branch: "main",
  autoDeploy: "yes",
  envVars: [
    { key: "NODE_VERSION", value: "20" },
    { key: "DRY_RUN", value: "true" },
    { key: "QUEUE_PATH", value: "/var/data/queue.json" },
    { key: "PUBLISH_INTERVAL_MINUTES", value: "15" },
    { key: "ADMIN_PASSWORD", value: adminPassword },
    { key: "SESSION_SECRET", value: sessionSecret },
    { key: "API_TOKEN", value: apiToken }
  ],
  serviceDetails: {
    runtime: "node",
    plan: "starter",
    region: "oregon",
    numInstances: 1,
    healthCheckPath: "/health",
    disk: {
      name: "strideos-social-data",
      mountPath: "/var/data",
      sizeGB: 1
    },
    envSpecificDetails: {
      buildCommand: "npm install",
      startCommand: "npm start"
    }
  }
};

const service = await renderFetch("/services", {
  method: "POST",
  body: payload
});

await writeFile(
  ".render-deploy-result.json",
  `${JSON.stringify(
    {
      service,
      adminPassword,
      apiToken,
      dryRun: true
    },
    null,
    2
  )}\n`
);

console.log("Render service created.");
console.log(`Workspace: ${owner.name} (${owner.id})`);
console.log(`Admin password saved in .render-deploy-result.json`);
console.log(`API token saved in .render-deploy-result.json`);
console.log("DRY_RUN is true. No real X posts will publish yet.");

async function renderFetch(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Render API ${response.status}: ${JSON.stringify(json)}`);
  }

  return json;
}

async function readSecret(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function randomSecret(bytes) {
  return randomBytes(bytes).toString("base64url");
}
