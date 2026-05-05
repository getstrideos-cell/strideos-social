import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createQueueItem, queuePath, readQueue, updateQueue } from "./queue-store.mjs";
import { refreshXAccessToken, XApiError } from "./x-client.mjs";
import { readXTokenState, writeXTokenState } from "./x-token-store.mjs";
import { createStructuredJson, hasOpenAI } from "./openai-client.mjs";
import { getGoogleAnalyticsStatus, runGoogleAnalyticsReport } from "./google-analytics-client.mjs";

const statePath = resolve(process.env.AGENT_STATE_PATH || join(dirname(queuePath), "agent-state.json"));
const timeZone = process.env.AGENT_TIMEZONE || "America/Sao_Paulo";
const boardHour = Number(process.env.FOUNDER_BOARD_HOUR || 8);
const boardMinute = Number(process.env.FOUNDER_BOARD_MINUTE || 30);
const growthHour = Number(process.env.GROWTH_PACK_HOUR || 9);
const growthMinute = Number(process.env.GROWTH_PACK_MINUTE || 0);
const momentHour = Number(process.env.FOUNDER_MOMENT_HOUR || 10);
const momentMinute = Number(process.env.FOUNDER_MOMENT_MINUTE || 30);
const schedulerIntervalMs = Number(process.env.AGENT_SCHEDULER_INTERVAL_MS || 60_000);
const targetHandles = (process.env.TARGET_X_HANDLES || "gregisenberg,noahkagan,george__mack,buildinpublic,openai,perplexity_ai,AnthropicAI")
  .split(",")
  .map((handle) => handle.trim().replace(/^@/, ""))
  .filter(Boolean);
const redditSubreddits = (process.env.REDDIT_SUBREDDITS || "SaaS,startups,Entrepreneur,SideProject,indiehackers")
  .split(",")
  .map((subreddit) => subreddit.trim().replace(/^r\//, ""))
  .filter(Boolean);
const redditQueries = (process.env.REDDIT_SEARCH_QUERIES || "solo founder,build in public,SaaS metrics,AI agents startup,distribution")
  .split(",")
  .map((query) => query.trim())
  .filter(Boolean);
const plausibleApiKey = process.env.PLAUSIBLE_API_KEY || "";
const plausibleSiteId = process.env.PLAUSIBLE_SITE_ID || "";
const plausibleHost = process.env.PLAUSIBLE_HOST || "https://plausible.io";
const posthogApiKey = process.env.POSTHOG_PERSONAL_API_KEY || "";
const posthogProjectId = process.env.POSTHOG_PROJECT_ID || "";
const posthogHost = (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(/\/$/, "");

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

  if (isWithinScheduleWindow(local, boardHour, boardMinute)) {
    results.push(await generateFounderBoard({ reason: "schedule", now }));
  }

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

  const board = await ensureFounderBoard(today, now);
  const signals = board?.signals || (await collectTrendSignals());
  const rawItems = buildGrowthPackItems(today, signals, board);
  const enhancedItems = await enhanceGrowthPackWithOpenAI(rawItems, board, signals);
  const items = enhancedItems.map((item) =>
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
    boardDate: board?.date || "",
    signals
  };
  await writeAgentState(latestState);

  return { agent: "growth-pack", status: "created", date: today, count: items.length };
}

export async function generateFounderBoard({ force = false, reason = "manual", now = new Date() } = {}) {
  const today = getLocalDateKey(now);
  const state = await readAgentState();

  if (!force && state.founderBoard?.date === today) {
    return { agent: "founder-board", status: "skipped", date: today, reason: "already-created" };
  }

  const signals = await collectTrendSignals();
  const board = await enhanceFounderBoardWithOpenAI(buildFounderBoard(today, signals, now, reason));
  const latestState = await readAgentState();
  latestState.founderBoard = board;
  await writeAgentState(latestState);

  return { agent: "founder-board", status: "created", date: today, signals: signals.length };
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
    recommendedSurface: signal.recommendedSurface,
    viralThesis: signal.viralThesis,
    evidence: signal.evidence,
    sourceUrl: signal.sourceUrl,
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
    const content = await readFile(statePath, "utf8");
    if (!content.trim()) return {};
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      console.warn("Agent state file is not valid JSON yet; using empty state for this run.");
      return {};
    }
    throw error;
  }
}

async function ensureFounderBoard(today, now) {
  const state = await readAgentState();
  if (state.founderBoard?.date === today) return state.founderBoard;

  const result = await generateFounderBoard({ reason: "growth-pack-dependency", now });
  if (result.status === "skipped") {
    return (await readAgentState()).founderBoard;
  }

  return (await readAgentState()).founderBoard;
}

function buildFounderBoard(today, signals, now, reason) {
  const primarySignal = signals[0] || { label: "solo founders are using AI to ship and distribute faster", source: "fallback" };
  const communitySignal =
    signals.find((signal) => signal.kind === "community") ||
    signals.find((signal) => signal.label?.toLowerCase().includes("build")) ||
    primarySignal;
  const aiSignal =
    signals.find((signal) => /ai|agent|claude|openai|anthropic/i.test(signal.label || "")) ||
    primarySignal;

  return {
    date: today,
    reason,
    createdAt: now.toISOString(),
    stage: "Landing page live. Core Stride OS product still in development. Social agent and approval workflow are the first working wedge.",
    signals,
    integrations: buildIntegrationStatus(signals),
    intelligence: hasOpenAI() ? "OpenAI enhanced" : "Rule-based fallback",
    marketRadar: {
      title: "Market Radar",
      summary: "Solo founders are paying attention to AI leverage, distribution, and proof-of-work. The opportunity is to position Stride OS as the operating rhythm that turns real progress into public narrative.",
      topSignals: signals.slice(0, 4).map((signal) => ({
        label: signal.label,
        source: signal.source,
        url: signal.url || signal.targetPostUrl || "",
        evidence: evidenceFor(signal)
      })),
      implication: "Do not market Stride OS as a polished automation toy. Market it as a founder operating layer that starts while the product is still being built."
    },
    marketingDirector: {
      title: "Marketing Director",
      distributionBet: "Make X the proof channel, then reuse the best ideas in the build-in-public community and founder-focused Reddit posts.",
      reasoning: `The strongest current angle is ${primarySignal.label}. Stride OS can enter that conversation by showing how a solo founder turns progress into distribution without sounding like a content machine.`,
      recommendedActions: [
        "Publish one profile post that names the current stage honestly: landing page live, product in development, distribution system being built in public.",
        "Leave one thoughtful reply on a large-account post about AI agents, solo founders, distribution, or shipping.",
        "Post one non-promotional question in the build-in-public community to learn how founders currently create weekly updates."
      ],
      experiment: {
        name: "Proof before product",
        hypothesis: "Honest early-stage proof-of-work will get better replies than polished product claims.",
        metric: "Replies from solo founders, profile visits, and landing page clicks.",
        duration: "7 days"
      },
      risk: "If every post points directly to Stride OS, it will feel like promotion. Keep most posts framed as founder operating lessons."
    },
    productDirector: {
      title: "Product Director",
      productBet: "Build the weekly founder update ritual before adding broad analytics or many channels.",
      reasoning: "The core product value is not writing tweets. It is helping a solo founder know what changed, explain it clearly, and build a distribution habit around real business data.",
      roadmapNow: [
        "Weekly check-in flow: Stripe snapshot plus five founder questions.",
        "Approval queue with evidence, surface, and rationale for every draft.",
        "Learning loop: after publishing, capture what got replies/clicks and feed it back into next week's recommendations."
      ],
      roadmapLater: [
        "Reddit and community-specific posting flows.",
        "Landing page conversion recommendations from comments and objections.",
        "Product feedback inbox that turns replies into roadmap suggestions."
      ],
      risk: "Do not overbuild the executive-agent metaphor before the weekly update loop feels obviously useful."
    },
    chiefOfStaff: {
      title: "Chief of Staff",
      todayFocus: "Use the board to produce one public proof-of-work post, one community learning post, and one high-context reply.",
      decisions: [
        "Keep Stride OS honest about stage: landing page and active project, not full app launch.",
        "Prioritize distribution learning over feature breadth this week.",
        "Treat replies and community posts as market research, not just engagement."
      ],
      nextMove: "Generate the growth pack, approve only the drafts with evidence, and reject anything that feels like generic build-in-public advice."
    },
    growthExperiment: {
      title: "Growth Experiment",
      name: "Founder Board narrative",
      channel: "X profile plus build-in-public community",
      hypothesis: "A solo founder publicly building with an AI founder board is more memorable than another SaaS scheduling tool.",
      action: "Post a transparent build note about adding Marketing Director and Product Director agents to Stride OS.",
      evidence: evidenceFor(aiSignal),
      sourceUrl: aiSignal.url || aiSignal.targetPostUrl || "",
      successMetric: "At least one qualified founder reply, DM, or landing click."
    }
  };
}

async function enhanceFounderBoardWithOpenAI(board) {
  if (!hasOpenAI()) return board;

  try {
    const enhanced = await createStructuredJson({
      name: "founder_board",
      schema: founderBoardSchema,
      maxOutputTokens: 2400,
      instructions: [
        "You are the AI Founder Board for Stride OS.",
        "Act like a pragmatic CMO, CPO, Market Intelligence lead, Chief of Staff, and Growth lead for a solo founder.",
        "Stride OS today: landing page is live, core product is still in development, social approval workflow exists, Stripe product is not ready.",
        "Audience: solo founders building early-stage SaaS in public.",
        "Voice: practical builder with a slight visionary edge. Honest, direct, no generic AI hype.",
        "Use only the provided signals. Do not invent metrics, customers, revenue, launches, or product features.",
        "Return concise strategic guidance that can directly feed content, replies, community posts, and product roadmap decisions."
      ].join("\n"),
      input: JSON.stringify({
        stage: board.stage,
        integrations: board.integrations,
        signals: board.signals,
        fallbackBoard: {
          marketRadar: board.marketRadar,
          marketingDirector: board.marketingDirector,
          productDirector: board.productDirector,
          chiefOfStaff: board.chiefOfStaff,
          growthExperiment: board.growthExperiment
        }
      })
    });

    return {
      ...board,
      intelligence: "OpenAI enhanced",
      marketRadar: { title: "Market Radar", ...enhanced.marketRadar },
      marketingDirector: { title: "Marketing Director", ...enhanced.marketingDirector },
      productDirector: { title: "Product Director", ...enhanced.productDirector },
      chiefOfStaff: { title: "Chief of Staff", ...enhanced.chiefOfStaff },
      growthExperiment: { title: "Growth Experiment", ...enhanced.growthExperiment }
    };
  } catch (error) {
    console.warn("OpenAI founder board enhancement failed:", error.message);
    return {
      ...board,
      intelligence: "Rule-based fallback",
      openAIError: error.message
    };
  }
}

async function enhanceGrowthPackWithOpenAI(items, board, signals) {
  if (!hasOpenAI()) return items;

  try {
    const enhanced = await createStructuredJson({
      name: "growth_pack",
      schema: growthPackSchema,
      maxOutputTokens: 2200,
      instructions: [
        "You are Stride OS's content strategist.",
        "Rewrite or improve the provided draft items using the Founder Board context.",
        "Keep every public text under 280 characters.",
        "The output must include exactly five items.",
        "Include at least one community-post item.",
        "Keep reply items only if they include a real replyToPostId from the input.",
        "Do not pretend Stride OS is fully launched. It currently has a landing page and project in development.",
        "No hashtags unless genuinely necessary. No AI-sounding hype. No fake metrics."
      ].join("\n"),
      input: JSON.stringify({
        board: {
          stage: board?.stage,
          marketRadar: board?.marketRadar,
          marketingDirector: board?.marketingDirector,
          productDirector: board?.productDirector,
          chiefOfStaff: board?.chiefOfStaff,
          growthExperiment: board?.growthExperiment
        },
        signals,
        draftItems: items
      })
    });

    const byReplyId = new Map(items.filter((item) => item.replyToPostId).map((item) => [item.replyToPostId, item]));
    return enhanced.items.slice(0, 5).map((item, index) => {
      const original = item.replyToPostId ? byReplyId.get(item.replyToPostId) || items[index] || {} : items[index] || {};
      const format = item.format === "community-post" ? "community-post" : original.format;
      return {
        ...original,
        type: item.type === "reply" && item.replyToPostId ? "reply" : "post",
        format,
        requiresManualPublish: format === "community-post" || Boolean(original.requiresManualPublish),
        recommendedSurface: item.recommendedSurface,
        viralThesis: item.viralThesis,
        evidence: item.evidence,
        sourceUrl: item.sourceUrl || original.sourceUrl,
        trendSignal: item.trendSignal,
        text: trimPost(item.text)
      };
    });
  } catch (error) {
    console.warn("OpenAI growth pack enhancement failed:", error.message);
    return items;
  }
}

function buildIntegrationStatus(signals) {
  const sources = new Set(signals.map((signal) => signal.source).filter(Boolean));
  return [
    {
      name: "X market radar",
      status: sources.has("x") ? "connected" : "not enough signal",
      detail: "Reads recent posts from target accounts when X API read access is available."
    },
    {
      name: "X performance",
      status: sources.has("x-performance") ? "connected" : "waiting",
      detail: "Learns from your published posts once they have X metrics."
    },
    {
      name: "Landing analytics",
      status: sources.has("plausible") || sources.has("posthog") || sources.has("google-analytics") ? "connected" : "needs connection",
      detail: "Uses Google Analytics OAuth, Plausible, or PostHog when connected."
    },
    {
      name: "Reddit/community radar",
      status: sources.has("reddit") ? "connected" : "limited",
      detail: `Watches r/${redditSubreddits.slice(0, 3).join(", r/")} and related founder searches.`
    },
    {
      name: "Internal feedback",
      status: sources.has("strideos") ? "connected" : "waiting",
      detail: "Uses approvals, rejections, failures, manual suggestions, and published queue history."
    }
  ];
}

function buildGrowthPackItems(today, signals) {
  const xSignals = signals.filter((signal) => signal.kind === "x-post");
  const primarySignal = signals[0] || { label: "AI agents are making solo founders faster", source: "fallback" };
  const communitySignal =
    signals.find((signal) => signal.kind === "community") ||
    signals[1] ||
    { label: "build-in-public works best when updates are tied to real progress", source: "fallback" };
  const replyTargets = xSignals.filter((signal) => signal.replyToPostId && signal.replySettings === "everyone").slice(0, 2);

  const items = [
    {
      type: "post",
      recommendedSurface: "Stride OS profile",
      viralThesis: "Contrarian and founder-specific: it pushes against the generic AI speed narrative and names the new bottleneck.",
      evidence: evidenceFor(primarySignal),
      sourceUrl: primarySignal.url,
      trendSignal: primarySignal.label,
      text: trimPost(`AI makes the first build easier.\n\nThat is not the same as making the founder easier to trust.\n\nThe new bottleneck for solo founders is clarity:\nwhat changed, what moved, what broke, and why anyone should keep watching.`)
    },
    {
      type: "post",
      recommendedSurface: "Stride OS profile",
      viralThesis: "Stage transparency feels more credible than polished product claims and can attract builders who want the real process.",
      evidence: "Stride OS is currently landing page plus active project, so the post is grounded in the actual build rather than pretending the full product is done.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Founders respond to honest process when the product is still being built.",
      text: trimPost(`Current Stride OS status:\n\nlanding page live\nproduct still being built\nsocial agent working before the core app is polished\n\nIt feels backwards, but maybe that is the point.\n\nDistribution is part of the product now.`)
    },
    {
      type: "post",
      recommendedSurface: "Stride OS profile",
      viralThesis: "The AI executive-board angle is more ownable than generic build-in-public advice and makes Stride OS feel bigger than a post generator.",
      evidence: "Stride OS now has Market Radar feeding Marketing Director and Product Director recommendations before content drafts are created.",
      trendSignal: "Solo founders are looking for leverage that feels like an operating team, not just isolated AI prompts.",
      text: trimPost(`I am adding a tiny founder board to Stride OS:\n\nMarket Radar -> Marketing Director -> Product Director -> content agents\n\nThe goal is not more posts.\n\nThe goal is better founder decisions that turn into better public updates.`)
    },
    {
      type: "post",
      format: "community-post",
      requiresManualPublish: true,
      recommendedSurface: "X build-in-public community",
      viralThesis: "Question format invites other builders to compare workflows; this is optimized for replies and relationship, not a direct pitch.",
      evidence: evidenceFor(communitySignal),
      sourceUrl: "https://x.com/i/communities/1493446837214187523",
      trendSignal: communitySignal.label,
      text: trimPost(`Question for builders here:\n\nwhen you post a weekly update, where does it start?\n\n1. memory\n2. changelog\n3. metrics\n4. screenshots\n5. whatever feels important that day\n\nI am trying to understand the real workflow behind consistent build in public.`)
    }
  ];

  for (const target of replyTargets) {
    items.push({
      type: "reply",
      replyToPostId: target.replyToPostId,
      targetAuthor: target.targetAuthor,
      targetHandle: target.targetHandle,
      targetPostUrl: target.targetPostUrl,
      targetPostText: target.targetPostText,
      targetPostSummary: target.targetPostSummary,
      replyRationale: `Relevant ${target.targetHandle} post with public replies open; reply adds the Stride OS worldview without pitching.`,
      recommendedSurface: `Reply to ${target.targetHandle}`,
      viralThesis: "Replying to a high-signal large-account post can create discovery; the reply is framed as a founder insight, not a product ad.",
      evidence: evidenceFor(target),
      sourceUrl: target.targetPostUrl,
      trendSignal: target.label,
      text: trimPost(replyTextFor(target))
    });
  }

  while (items.length < 5) {
    items.push(nextProfilePost(items.length, communitySignal));
  }

  return items.slice(0, 5).map((item) => ({ ...item, generatedForDate: today }));
}

async function collectTrendSignals() {
  const fallback = [
    { label: "AI agents are making solo founders faster", source: "fallback", kind: "trend" },
    { label: "real progress beats polished founder theater", source: "fallback", kind: "community" }
  ];

  const queries = ["AI agents solo founder SaaS", "build in public SaaS founder metrics"];
  const signals = [];

  signals.push(...(await collectXSignals()));
  signals.push(...(await collectXPerformanceSignals()));
  signals.push(...(await collectPlausibleSignals()));
  signals.push(...(await collectPostHogSignals()));
  signals.push(...(await collectGoogleAnalyticsSignals()));
  signals.push(...(await collectRedditSignals()));
  signals.push(...(await collectInternalFeedbackSignals()));

  for (const query of queries) {
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(query)}`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const json = await response.json();
      const hit = json.hits?.find((candidate) => candidate.title || candidate.story_title);
      const title = hit?.title || hit?.story_title;
      if (title) signals.push({ label: title, source: "hn", kind: "trend", url: hit.url || hit.story_url || "" });
    } catch {
      // Fallback signals keep the agent reliable when source fetches fail.
    }
  }

  return dedupeSignals(signals).length > 0 ? dedupeSignals(signals).slice(0, 12) : fallback;
}

async function collectXSignals() {
  const tokenState = await getFreshXTokenState();
  if (!tokenState.accessToken) return [];

  const signals = [];

  for (const handle of targetHandles) {
    try {
      const user = await xFetchJson(
        `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,verified`,
        tokenState
      );
      const userId = user?.data?.id;
      if (!userId) continue;

      const tweets = await xFetchJson(
        `https://api.x.com/2/users/${userId}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=created_at,public_metrics,reply_settings,conversation_id`,
        tokenState
      );

      for (const tweet of tweets?.data || []) {
        const metrics = tweet.public_metrics || {};
        const text = normalizeTweetText(tweet.text || "");
        const relevant = isRelevantTweet(text);
        if (!relevant) continue;

        const handleWithAt = `@${handle}`;
        const score =
          Number(metrics.like_count || 0) +
          Number(metrics.reply_count || 0) * 4 +
          Number(metrics.retweet_count || 0) * 3 +
          Number(metrics.quote_count || 0) * 3;

        signals.push({
          kind: handle === "buildinpublic" ? "community" : "x-post",
          label: `${handleWithAt}: ${text.slice(0, 120)}`,
          source: "x",
          url: `https://x.com/${handle}/status/${tweet.id}`,
          targetPostUrl: `https://x.com/${handle}/status/${tweet.id}`,
          replyToPostId: tweet.id,
          targetAuthor: user.data.name || handleWithAt,
          targetHandle: handleWithAt,
          targetPostText: text,
          targetPostSummary: summarizeTweet(text),
          replySettings: tweet.reply_settings || "unknown",
          metrics,
          score
        });
      }
    } catch (error) {
      console.warn(`Could not collect X signals for ${handle}:`, error.message);
    }
  }

  return signals.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 4);
}

async function collectXPerformanceSignals() {
  const tokenState = await getFreshXTokenState();
  if (!tokenState.accessToken) return [];

  let queue;
  try {
    queue = await readQueue();
  } catch {
    return [];
  }

  const ids = queue.items
    .filter((item) => item.status === "published" && item.xPostId)
    .slice(0, 25)
    .map((item) => item.xPostId);
  if (ids.length === 0) return [];

  try {
    const tweets = await xFetchJson(
      `https://api.x.com/2/tweets?ids=${encodeURIComponent(ids.join(","))}&tweet.fields=created_at,public_metrics,text`,
      tokenState
    );
    return (tweets.data || [])
      .map((tweet) => {
        const metrics = tweet.public_metrics || {};
        const score =
          Number(metrics.like_count || 0) +
          Number(metrics.reply_count || 0) * 4 +
          Number(metrics.retweet_count || 0) * 3 +
          Number(metrics.quote_count || 0) * 3;
        return {
          kind: "performance",
          source: "x-performance",
          label: `Published post performance: ${normalizeTweetText(tweet.text || "").slice(0, 120)}`,
          url: `https://x.com/i/web/status/${tweet.id}`,
          metrics,
          score
        };
      })
      .filter((signal) => signal.score > 0)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, 3);
  } catch (error) {
    console.warn("Could not collect X performance signals:", error.message);
    return [];
  }
}

async function collectPlausibleSignals() {
  if (!plausibleApiKey || !plausibleSiteId) return [];

  try {
    const overview = await plausibleQuery({
      site_id: plausibleSiteId,
      metrics: ["visitors", "pageviews", "visits", "bounce_rate"],
      date_range: "7d"
    });
    const sources = await plausibleQuery({
      site_id: plausibleSiteId,
      metrics: ["visitors"],
      dimensions: ["visit:source"],
      date_range: "7d",
      order_by: [["visitors", "desc"]],
      pagination: { limit: 5, offset: 0 }
    });

    const overviewRow = overview.results?.[0]?.metrics || [];
    const topSource = sources.results?.[0];
    const visitors = Number(overviewRow[0] || 0);
    const pageviews = Number(overviewRow[1] || 0);
    const topSourceName = topSource?.dimensions?.[0] || "";
    const topSourceVisitors = Number(topSource?.metrics?.[0] || 0);

    return [
      {
        kind: "landing-analytics",
        source: "plausible",
        label: `Landing analytics: ${visitors} visitors and ${pageviews} pageviews in the last 7 days${topSourceName ? `; top source ${topSourceName} with ${topSourceVisitors} visitors` : ""}`,
        metrics: { visitors, pageviews, topSourceVisitors },
        score: visitors + topSourceVisitors * 2
      }
    ];
  } catch (error) {
    console.warn("Could not collect Plausible signals:", error.message);
    return [];
  }
}

async function plausibleQuery(body) {
  const response = await fetch(`${plausibleHost.replace(/\/$/, "")}/api/v2/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${plausibleApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Plausible returned ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  return json;
}

async function collectPostHogSignals() {
  if (!posthogApiKey || !posthogProjectId) return [];

  try {
    const events = await posthogQuery(
      "SELECT event, count() AS event_count FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY event_count DESC LIMIT 5"
    );
    const urls = await posthogQuery(
      "SELECT properties.$current_url AS url, count() AS views FROM events WHERE timestamp > now() - INTERVAL 7 DAY AND event = '$pageview' GROUP BY url ORDER BY views DESC LIMIT 5"
    );

    const topEvent = events.results?.[0] || [];
    const topUrl = urls.results?.[0] || [];
    const topEventName = topEvent[0] || "";
    const topEventCount = Number(topEvent[1] || 0);
    const topUrlValue = topUrl[0] || "";
    const topUrlViews = Number(topUrl[1] || 0);

    return [
      {
        kind: "product-analytics",
        source: "posthog",
        label: `Product/landing analytics: top event ${topEventName || "unknown"} (${topEventCount}); top page ${topUrlValue || "unknown"} (${topUrlViews} views)`,
        url: topUrlValue,
        metrics: { topEventCount, topUrlViews },
        score: topEventCount + topUrlViews
      }
    ];
  } catch (error) {
    console.warn("Could not collect PostHog signals:", error.message);
    return [];
  }
}

async function collectGoogleAnalyticsSignals() {
  const status = await getGoogleAnalyticsStatus();
  if (!status.configured || !status.connected) return [];

  try {
    const overview = await runGoogleAnalyticsReport({
      metrics: ["activeUsers", "screenPageViews", "sessions", "engagementRate"],
      limit: 1
    });
    const sources = await runGoogleAnalyticsReport({
      dimensions: ["sessionSource"],
      metrics: ["activeUsers", "sessions"],
      limit: 5
    });
    const pages = await runGoogleAnalyticsReport({
      dimensions: ["pagePath"],
      metrics: ["screenPageViews", "activeUsers"],
      limit: 5
    });

    const metrics = overview.rows?.[0]?.metricValues || [];
    const activeUsers = Number(metrics[0]?.value || 0);
    const pageViews = Number(metrics[1]?.value || 0);
    const sessions = Number(metrics[2]?.value || 0);
    const engagementRate = Number(metrics[3]?.value || 0);
    const topSource = sources.rows?.[0];
    const topPage = pages.rows?.[0];
    const topSourceName = topSource?.dimensionValues?.[0]?.value || "";
    const topSourceUsers = Number(topSource?.metricValues?.[0]?.value || 0);
    const topPagePath = topPage?.dimensionValues?.[0]?.value || "";
    const topPageViews = Number(topPage?.metricValues?.[0]?.value || 0);

    return [
      {
        kind: "landing-analytics",
        source: "google-analytics",
        label: `Google Analytics: ${activeUsers} active users, ${sessions} sessions, ${pageViews} page views in the last 7 days${topSourceName ? `; top source ${topSourceName} with ${topSourceUsers} users` : ""}${topPagePath ? `; top page ${topPagePath} with ${topPageViews} views` : ""}`,
        metrics: { activeUsers, sessions, pageViews, engagementRate, topSourceUsers, topPageViews },
        score: activeUsers + sessions + topSourceUsers * 2 + topPageViews
      }
    ];
  } catch (error) {
    console.warn("Could not collect Google Analytics signals:", error.message);
    return [];
  }
}

async function posthogQuery(query) {
  const response = await fetch(`${posthogHost}/api/projects/${encodeURIComponent(posthogProjectId)}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${posthogApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`PostHog returned ${response.status}: ${JSON.stringify(json).slice(0, 240)}`);
  return json;
}

async function collectRedditSignals() {
  const signals = [];
  let loggedFailure = false;

  for (const subreddit of redditSubreddits.slice(0, 6)) {
    for (const query of redditQueries.slice(0, 3)) {
      try {
        const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=hot&t=week&limit=5&raw_json=1`;
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "StrideOSSocial/0.1 by getstrideos"
          }
        });
        if (!response.ok) continue;
        const json = await response.json();
        for (const child of json.data?.children || []) {
          const post = child.data || {};
          const text = normalizeTweetText(`${post.title || ""} ${post.selftext || ""}`);
          if (!isRelevantTweet(text)) continue;
          const score = Number(post.score || 0) + Number(post.num_comments || 0) * 3;
          signals.push({
            kind: "reddit",
            source: "reddit",
            label: `r/${subreddit}: ${post.title || text.slice(0, 120)}`,
            url: post.permalink ? `https://www.reddit.com${post.permalink}` : "",
            metrics: { score: post.score || 0, comments: post.num_comments || 0 },
            score
          });
        }
      } catch (error) {
        if (!loggedFailure) {
          console.warn("Could not collect Reddit signals:", error.message);
          loggedFailure = true;
        }
      }
    }
  }

  return signals.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5);
}

async function collectInternalFeedbackSignals() {
  try {
    const queue = await readQueue();
    const rejected = queue.items.filter((item) => item.status === "rejected").length;
    const failed = queue.items.filter((item) => item.status === "failed").length;
    const published = queue.items.filter((item) => item.status === "published").length;
    const approved = queue.items.filter((item) => item.status === "approved").length;
    const manual = queue.items.filter((item) => item.requiresManualAsset || item.requiresManualPublish).length;

    return [
      {
        kind: "internal-feedback",
        source: "strideos",
        label: `Internal queue: ${published} published, ${approved} approved, ${rejected} rejected, ${failed} failed, ${manual} manual suggestions`,
        metrics: { published, approved, rejected, failed, manual },
        score: published + rejected + manual
      }
    ];
  } catch {
    return [];
  }
}

async function getFreshXTokenState() {
  const tokenState = await readXTokenState();
  if (!tokenState.accessToken) return tokenState;

  return tokenState;
}

async function xFetchJson(url, tokenState) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokenState.accessToken}`,
      Accept: "application/json"
    }
  });
  const json = await response.json().catch(() => ({}));

  if (response.status === 401 && tokenState.refreshToken) {
    const refreshed = await refreshXAccessToken({
      refreshToken: tokenState.refreshToken,
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET
    });
    tokenState.accessToken = refreshed.accessToken;
    tokenState.refreshToken = refreshed.refreshToken;
    tokenState.refreshedAt = new Date().toISOString();
    await writeXTokenState(tokenState);
    return xFetchJson(url, tokenState);
  }

  if (!response.ok) {
    throw new XApiError(response.status, json, `X API returned ${response.status}`);
  }

  return json;
}

function evidenceFor(signal) {
  if (!signal) return "";
  if (signal.source === "x") {
    const metrics = signal.metrics || {};
    const metricText = [
      metrics.like_count ? `${metrics.like_count} likes` : "",
      metrics.reply_count ? `${metrics.reply_count} replies` : "",
      metrics.retweet_count ? `${metrics.retweet_count} reposts` : ""
    ]
      .filter(Boolean)
      .join(", ");
    return `${signal.targetHandle || "X"} post about a relevant founder/AI/build-in-public topic${metricText ? ` with ${metricText}` : ""}.`;
  }
  if (signal.source === "x-performance") {
    const metrics = signal.metrics || {};
    return `Your own published post had ${metrics.like_count || 0} likes, ${metrics.reply_count || 0} replies, ${metrics.retweet_count || 0} reposts, and ${metrics.quote_count || 0} quotes.`;
  }
  if (signal.source === "plausible") return signal.label;
  if (signal.source === "posthog") return signal.label;
  if (signal.source === "google-analytics") return signal.label;
  if (signal.source === "reddit") {
    const metrics = signal.metrics || {};
    return `Reddit discussion with ${metrics.score || 0} upvotes and ${metrics.comments || 0} comments.`;
  }
  if (signal.source === "strideos") return signal.label;
  if (signal.source === "hn") return `Recent Hacker News signal: ${signal.label}.`;
  return `Strategic fit with Stride OS: ${signal.label}.`;
}

function dedupeSignals(signals) {
  const seen = new Set();
  const unique = [];
  for (const signal of signals) {
    const key = `${signal.source || ""}:${signal.url || signal.label || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  return unique.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

const stringArraySchema = {
  type: "array",
  items: { type: "string" }
};

const signalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string" },
    source: { type: "string" },
    url: { type: "string" },
    evidence: { type: "string" }
  },
  required: ["label", "source", "url", "evidence"]
};

const founderBoardSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    marketRadar: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        implication: { type: "string" },
        topSignals: { type: "array", items: signalSchema }
      },
      required: ["summary", "implication", "topSignals"]
    },
    marketingDirector: {
      type: "object",
      additionalProperties: false,
      properties: {
        distributionBet: { type: "string" },
        reasoning: { type: "string" },
        recommendedActions: stringArraySchema,
        experiment: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            hypothesis: { type: "string" },
            metric: { type: "string" },
            duration: { type: "string" }
          },
          required: ["name", "hypothesis", "metric", "duration"]
        },
        risk: { type: "string" }
      },
      required: ["distributionBet", "reasoning", "recommendedActions", "experiment", "risk"]
    },
    productDirector: {
      type: "object",
      additionalProperties: false,
      properties: {
        productBet: { type: "string" },
        reasoning: { type: "string" },
        roadmapNow: stringArraySchema,
        roadmapLater: stringArraySchema,
        risk: { type: "string" }
      },
      required: ["productBet", "reasoning", "roadmapNow", "roadmapLater", "risk"]
    },
    chiefOfStaff: {
      type: "object",
      additionalProperties: false,
      properties: {
        todayFocus: { type: "string" },
        decisions: stringArraySchema,
        nextMove: { type: "string" }
      },
      required: ["todayFocus", "decisions", "nextMove"]
    },
    growthExperiment: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        channel: { type: "string" },
        hypothesis: { type: "string" },
        action: { type: "string" },
        evidence: { type: "string" },
        sourceUrl: { type: "string" },
        successMetric: { type: "string" }
      },
      required: ["name", "channel", "hypothesis", "action", "evidence", "sourceUrl", "successMetric"]
    }
  },
  required: ["marketRadar", "marketingDirector", "productDirector", "chiefOfStaff", "growthExperiment"]
};

const growthPackItemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["post", "reply"] },
    format: { type: "string", enum: ["standard", "community-post"] },
    replyToPostId: { type: "string" },
    recommendedSurface: { type: "string" },
    viralThesis: { type: "string" },
    evidence: { type: "string" },
    sourceUrl: { type: "string" },
    trendSignal: { type: "string" },
    text: { type: "string" }
  },
  required: ["type", "format", "replyToPostId", "recommendedSurface", "viralThesis", "evidence", "sourceUrl", "trendSignal", "text"]
};

const growthPackSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      minItems: 5,
      maxItems: 5,
      items: growthPackItemSchema
    }
  },
  required: ["items"]
};

function replyTextFor(signal) {
  const text = (signal.targetPostText || "").toLowerCase();
  if (text.includes("agent") || text.includes("ai")) {
    return "The underrated shift is that AI makes shipping faster, but clarity becomes more valuable.\n\nSolo founders still need a rhythm for what changed, what moved, and what is worth sharing.";
  }
  if (text.includes("distribution") || text.includes("audience")) {
    return "This is the part founders underestimate.\n\nDistribution gets easier when the weekly story is tied to real progress, not just opinions or polished launch posts.";
  }
  return "The best build-in-public updates usually do not feel like content.\n\nThey feel like a clear operating note: what changed, what was learned, and what happens next.";
}

function normalizeTweetText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isRelevantTweet(text) {
  const lower = text.toLowerCase();
  return [
    "solo founder",
    "founder",
    "build in public",
    "building in public",
    "saas",
    "startup",
    "distribution",
    "ai agent",
    "agents",
    "ship",
    "shipping",
    "audience",
    "revenue",
    "mrr"
  ].some((keyword) => lower.includes(keyword));
}

function summarizeTweet(text) {
  if (text.length <= 180) return text;
  return `${text.slice(0, 177).trimEnd()}...`;
}

function pickFounderMomentSignal(today) {
  const options = [
    {
      title: "Landing page before product",
      recommendedSurface: "Manual post on Stride OS profile",
      viralThesis: "A real laptop/workspace photo makes the early-stage build tangible and avoids the generic AI-generated founder advice pattern.",
      evidence: "The product is still in development, while the landing page and social agent already exist. That tension is the story.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Founders are using AI to ship faster, but distribution and narrative now start before the full product is finished.",
      whyNow: "Stride OS is honestly still landing page plus active project. Showing that stage makes the build feel real and avoids overclaiming.",
      visualBrief: "Take a photo of your laptop with the Stride OS landing page open and your project/editor or notes visible beside it. Do not show fake product screens.",
      captureInstruction: "Open getstrideos.com on one side and your actual project workspace or notes on the other. Hide secrets, tokens, private tabs, and anything customer-related. Use a normal desk photo, not a polished mockup.",
      postingNotes: "Frame it as a real build note: landing page is live, product is in progress, and you are building the distribution engine in public. Do not imply the full app is launched.",
      imageAlt: "Laptop showing the Stride OS landing page beside project notes or code, with private details hidden.",
      text: "Current Stride OS reality:\n\nlanding page is live\nproduct is still being built\nI am building the distribution system in public too\n\nIt feels early because it is.\n\nBut I want the story to compound while the product does."
    },
    {
      title: "The messy founder operating note",
      recommendedSurface: "Manual post on Stride OS profile",
      viralThesis: "Unpolished proof-of-work photos can create more trust than abstract build-in-public advice because they show the founder is actually in the work.",
      evidence: "Stride OS is currently an active project with the core product still being built, so the most honest content is the operating note behind the product.",
      sourceUrl: "https://getstrideos.com",
      trendSignal: "Build-in-public posts that show unfinished work can outperform generic advice because they create proof of work and invite builders into the process.",
      whyNow: "The main Stride OS app is still in development, so the strongest visual is the honest operating layer: notes, landing page, tasks, and decisions.",
      visualBrief: "Photo of a notebook or laptop note with the five questions you want Stride OS to ask each week. Put the landing page in the background if possible.",
      captureInstruction: "Write the five questions on paper or in a notes app. Keep the product unfinishedness visible but not chaotic. Hide private information.",
      postingNotes: "Make the caption about the insight behind the product, not a feature announcement.",
      imageAlt: "Founder notes showing five weekly build-in-public questions with the Stride OS landing page in the background.",
      text: "I do not have the full Stride OS app polished yet.\n\nBut the core idea keeps getting clearer:\n\nfounder updates should start from what actually changed that week.\n\nThe product is being built around that ritual."
    }
  ];

  return options[hashDate(today) % options.length];
}

function nextProfilePost(index, communitySignal) {
  const posts = [
    {
      viralThesis: "Checklist posts are saveable and reply-friendly, but this one is tied to operating rhythm instead of generic content advice.",
      evidence: "This maps directly to Stride OS: Stripe data plus five weekly questions before generating a public update.",
      trendSignal: "Build in public works better when the update starts from evidence.",
      text: trimPost(`A weekly founder update should not start from \"what should I post?\"\n\nIt should start from:\n\nwhat shipped\nwhat moved\nwhat broke\nwhat changed in the numbers\nwhat I learned\n\nThat is the difference between content and operating in public.`)
    },
    {
      viralThesis: "Anti-theater framing attracts builders tired of generic build-in-public advice.",
      evidence: evidenceFor(communitySignal),
      sourceUrl: communitySignal.url,
      trendSignal: communitySignal.label,
      text: trimPost(`Build in public gets weird when it becomes performance.\n\nThe useful version is quieter:\n\nwhat changed\nwhat you tried\nwhat the numbers said\nwhat you are doing next\n\nThat is the story I want Stride OS to help founders tell.`)
    }
  ];
  return {
    type: "post",
    recommendedSurface: "Stride OS profile",
    ...posts[index % posts.length]
  };
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
