import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createQueueItem, queuePath, updateQueue } from "./queue-store.mjs";

const statePath = resolve(process.env.AGENT_STATE_PATH || join(dirname(queuePath), "agent-state.json"));
const timeZone = process.env.AGENT_TIMEZONE || "America/Sao_Paulo";
const growthHour = Number(process.env.GROWTH_PACK_HOUR || 9);
const growthMinute = Number(process.env.GROWTH_PACK_MINUTE || 0);
const momentHour = Number(process.env.FOUNDER_MOMENT_HOUR || 10);
const momentMinute = Number(process.env.FOUNDER_MOMENT_MINUTE || 30);
const schedulerIntervalMs = Number(process.env.AGENT_SCHEDULER_INTERVAL_MS || 60_000);

let schedulerStarted = false;
let schedulerRunning = false;

export function startRenderAgents() {
  if (schedulerStarted || process.env.RENDER_AGENTS_ENABLED === "false") return;
  schedulerStarted = true;

  setInterval(async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      await runDueRenderAgents();
    } catch (error) {
      console.error("Render agents failed:", error);
    } finally {
      schedulerRunning = false;
    }
  }, schedulerIntervalMs);

  console.log("Stride OS Render agents enabled.");
}

export async function runDueRenderAgents(now = new Date()) {
  const local = getLocalTimeParts(now);
  const results = [];

  if (isWithinScheduleWindow(local, growthHour, growthMinute)) {
    results.push(await generateDailyGrowthPack({ reason: "schedule", now }));
  }

  if (isWithinScheduleWindow(local, momentHour, momentMinute)) {
    results.push(await generateFounderMoment({ reason: "schedule", now }));
  }

  return results;
}

export async function generateDailyGrowthPack({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.growthPack?.date === today) {
    return { agent: "growth-pack", status: "skipped", date: today, reason: "already-created" };
  }

  const signals = await collectTrendSignals();
  const items = buildGrowthPackItems(today, signals).map((item) =>
    createQueueItem({
      ...item,
      status: "draft",
      source: "render-growth-pack"
    })
  );

  await updateQueue((queue) => {
    queue.items.unshift(...items);
  });

  const latestState = await readAgentState();
  latestState.growthPack = {
    date: today,
    reason,
    createdAt: now.toISOString(),
    count: items.length,
    signals
  };
  await writeAgentState(latestState);

  return { agent: "growth-pack", status: "created", date: today, count: items.length };
}

export async function generateFounderMoment({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.founderMoment?.date === today) {
    return { agent: "founder-moment", status: "skipped", date: today, reason: "already-created" };
  }

  const signal = pickFounderMomentSignal(today);
  const item = createQueueItem({
    type: "post",
    format: "founder-moment",
    status: "draft",
    source: "render-founder-moment",
    requiresManualAsset: true,
    title: signal.title,
    trendSignal: signal.trendSignal,
    whyNow: signal.whyNow,
    visualBrief: signal.visualBrief,
    captureInstruction: signal.captureInstruction,
    postingNotes: signal.postingNotes,
    imageAlt: signal.imageAlt,
    text: signal.text
  });

  await updateQueue((queue) => {
    queue.items.unshift(item);
  });

  const latestState = await readAgentState();
  latestState.founderMoment = {
    date: today,
    reason,
    createdAt: now.toISOString(),
    title: item.title
  };
  await writeAgentState(latestState);

  return { agent: "founder-moment", status: "created", date: today, count: 1 };
}

export async function readAgentState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function buildGrowthPackItems(today, signals) {
  const primarySignal = signals[0]?.label || "AI agents are making solo founders faster";
  const communitySignal = signals[1]?.label || "build-in-public works best when updates are tied to real progress";

  return [
    {
      type: "post",
      text: trimPost(`AI agents make it easier to ship alone.\n\nThat changes the real bottleneck for solo founders.\n\nIt is no longer just \"can I build this?\"\n\nIt is \"can I explain what changed clearly enough that people want to follow the journey?\"`)
    },
    {
      type: "post",
      text: trimPost(`Today's founder signal: ${primarySignal}.\n\nThe faster we ship, the easier it is to lose the thread.\n\nA good weekly update turns scattered progress into one clear story.`)
    },
    {
      type: "post",
      text: trimPost(`A weekly founder update should not start from \"what should I post?\"\n\nIt should start from:\n\nwhat shipped\nwhat moved\nwhat broke\nwhat changed in the numbers\nwhat I learned\n\nThat is the difference between content and operating in public.`)
    },
    {
      type: "post",
      text: trimPost(`I am building Stride OS because I think solo founders need fewer blank pages and more weekly rhythm.\n\nConnect the numbers.\nAnswer the real questions.\nShip the update.\n\nThat should be a habit, not a content sprint.`)
    },
    {
      type: "post",
      text: trimPost(`${communitySignal}.\n\nThat is the part of build in public I care about most:\n\nnot looking busy, but making the work legible.`)
    }
  ].map((item) => ({ ...item, trendSignal: primarySignal, generatedForDate: today }));
}

async function collectTrendSignals() {
  const fallback = [
    { label: "AI agents are making solo founders faster", source: "fallback" },
    { label: "real progress beats polished founder theater", source: "fallback" }
  ];

  const queries = ["AI agents solo founder SaaS", "build in public SaaS founder metrics"];
  const signals = [];

  for (const query of queries) {
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const json = await response.json();
      const hit = json.hits?.find((candidate) => candidate.title || candidate.story_title);
      const title = hit?.title || hit?.story_title;
      if (title) signals.push({ label: title, source: "hn", url: hit.url || hit.story_url || "" });
    } catch {
      // Fallback signals keep the agent reliable when source fetches fail.
    }
  }

  return signals.length > 0 ? signals.slice(0, 2) : fallback;
}

function pickFounderMomentSignal(today) {
  const options = [
    {
      title: "The 5 questions behind my weekly update",
      trendSignal: "AI agents are accelerating shipping, but founders still need a repeatable way to turn real progress into public updates.",
      whyNow: "The current AI-agent conversation is full of speed. A real behind-the-scenes shot reframes Stride OS around clarity and rhythm.",
      visualBrief: "Take a real desk or laptop photo with Stride OS open to the five weekly questions and a draft update. Hide or blur any Stripe/customer data.",
      captureInstruction: "Open the weekly questions and draft output. Put notes or a coffee nearby if natural. Blur numbers, customer names, invoices, and any identifiers. Use the least-polished real shot.",
      postingNotes: "Post as a builder note. Keep the photo honest and avoid adding a marketing banner.",
      imageAlt: "Laptop showing a weekly founder check-in with five questions and a generated draft update, with sensitive data hidden.",
      text: "AI agents help me ship faster, but the hard part is still sharing progress without founder-theater.\n\nMy weekly rhythm:\nconnect Stripe -> answer 5 questions -> get a draft update -> tweak in my voice.\n\nReal inputs > vague updates."
    },
    {
      title: "Numbers before content",
      trendSignal: "Build-in-public conversations keep drifting toward content tactics, while founders still need operating signal.",
      whyNow: "A simple photo of numbers hidden + notes visible makes the point that the update starts from reality, not a content prompt.",
      visualBrief: "Photo of your laptop with Stripe blurred on one side and Stride OS / notes on the other.",
      captureInstruction: "Hide all Stripe values and customer details. Keep only the shape of the workflow visible: metrics -> notes -> draft.",
      postingNotes: "Caption should feel like a lesson learned while building, not a launch announcement.",
      imageAlt: "Laptop workflow showing blurred Stripe metrics beside notes for a founder update.",
      text: "I keep coming back to this: founder updates get better when they start with reality.\n\nNot content ideas.\nNot vague momentum.\n\nNumbers, shipped work, lessons, then the story."
    }
  ];

  return options[hashDate(today) % options.length];
}

async function writeAgentState(state) {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function trimPost(text) {
  if (text.length <= 280) return text;
  return `${text.slice(0, 276).trimEnd()}...`;
}

function getLocalDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

function getLocalTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  return {
    hour: Number(part(parts, "hour")),
    minute: Number(part(parts, "minute"))
  };
}

function part(parts, type) {
  return parts.find((entry) => entry.type === type)?.value;
}

function hashDate(value) {
  return [...value].reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function isWithinScheduleWindow(local, hour, minute) {
  if (local.hour !== hour) return false;
  return local.minute >= minute && local.minute < minute + 5;
}
