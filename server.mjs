import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { loadEnv } from "./scripts/load-env.mjs";
import { createQueueItem, readQueue, updateQueue } from "./scripts/queue-store.mjs";
import { publishApproved } from "./scripts/publisher.mjs";
import { generateDailyGrowthPack, generateFounderBoard, generateFounderMoment, generateXAccountEvolution, readAgentState, startRenderAgents } from "./scripts/render-agents.mjs";
import { buildGoogleAuthUrl, exchangeGoogleCode, getGoogleAnalyticsStatus, getGoogleRedirectUri, hasGoogleAnalyticsConfig } from "./scripts/google-analytics-client.mjs";

await loadEnv();

const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const apiToken = process.env.API_TOKEN || "";
const dryRun = process.env.DRY_RUN !== "false";
const accessToken = process.env.X_USER_ACCESS_TOKEN;
const publishIntervalMinutes = Number(process.env.PUBLISH_INTERVAL_MINUTES || 0);

if (!adminPassword) {
  console.warn("ADMIN_PASSWORD is not set. Set it before deploying publicly.");
}

if (publishIntervalMinutes > 0) {
  setInterval(async () => {
    try {
      const results = await publishApproved({ accessToken, dryRun });
      if (results.length > 0) {
        console.log("Background publisher:", JSON.stringify(results));
      }
    } catch (error) {
      console.error("Background publisher failed:", error);
    }
  }, publishIntervalMinutes * 60 * 1000);
}

startRenderAgents();

const ROUTES = {
  hoje: "/",
  aprovacao: "/aprovacao",
  conselho: "/conselho",
  aprendizados: "/aprendizados",
  configuracoes: "/configuracoes"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/health") return sendText(res, 200, "ok");
    if (url.pathname === "/api/items" && req.method === "POST") return handleApiCreateItem(req, res);
    if (url.pathname === "/login" && req.method === "GET") return sendHtml(res, renderLogin());
    if (url.pathname === "/login" && req.method === "POST") return handleLogin(req, res);

    if (!isAuthenticated(req)) return redirect(res, "/login");

    if (url.pathname === "/logout" && req.method === "POST") return handleLogout(res);

    if (url.pathname === "/" && req.method === "GET") return handleHomePage(req, res);
    if (url.pathname === "/aprovacao" && req.method === "GET") return handleApprovalPage(req, res, url);
    if (url.pathname === "/conselho" && req.method === "GET") return handleCouncilPage(req, res);
    if (url.pathname === "/aprendizados" && req.method === "GET") return handleLearningsPage(req, res);
    if (url.pathname === "/configuracoes" && req.method === "GET") return handleSettingsPage(req, res);

    if (url.pathname === "/auth/google" && req.method === "POST") return handleGoogleAuth(req, res);
    if (url.pathname === "/auth/google/callback" && req.method === "GET") return handleGoogleCallback(req, res, url);

    if (url.pathname === "/items" && req.method === "POST") return handleCreateItem(req, res);
    if (url.pathname === "/agents/run/growth" && req.method === "POST") return handleRunGrowthAgent(res);
    if (url.pathname === "/agents/run/board" && req.method === "POST") return handleRunFounderBoardAgent(res);
    if (url.pathname === "/agents/run/founder-moment" && req.method === "POST") return handleRunFounderMomentAgent(res);
    if (url.pathname === "/agents/run/x-evolution" && req.method === "POST") return handleRunXEvolutionAgent(res);
    if (url.pathname === "/archive/delete-rejected" && req.method === "POST") return handleDeleteRejected(req, res);

    const itemAction = url.pathname.match(/^\/items\/([^/]+)\/(approve|reject|draft|update|publish|delete|convert-to-post|manual-posted)$/);
    if (itemAction && req.method === "POST") {
      const [, id, action] = itemAction;
      return handleItemAction(req, res, id, action);
    }

    if (url.pathname === "/publish" && req.method === "POST") return handlePublishNow(req, res);

    return sendText(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    return sendText(res, 500, error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, () => {
  console.log(`Stride OS publisher running on http://localhost:${port}`);
});

// ============================================================================
// PAGE HANDLERS
// ============================================================================

async function handleHomePage(_req, res) {
  const queue = await readQueue();
  const agentState = await readAgentState();
  const googleAnalytics = await getGoogleAnalyticsStatus();
  return sendHtml(res, renderHomePage(queue, { dryRun, agentState, googleAnalytics, publishIntervalMinutes }));
}

async function handleApprovalPage(_req, res, url) {
  const queue = await readQueue();
  const agentState = await readAgentState();
  const googleAnalytics = await getGoogleAnalyticsStatus();
  const tab = url.searchParams.get("aba") || "posts";
  return sendHtml(res, renderApprovalPage(queue, { dryRun, agentState, googleAnalytics }, tab));
}

async function handleCouncilPage(_req, res) {
  const agentState = await readAgentState();
  const googleAnalytics = await getGoogleAnalyticsStatus();
  return sendHtml(res, renderCouncilPage({ dryRun, agentState, googleAnalytics }));
}

async function handleLearningsPage(_req, res) {
  const queue = await readQueue();
  const agentState = await readAgentState();
  const googleAnalytics = await getGoogleAnalyticsStatus();
  return sendHtml(res, renderLearningsPage(queue, { dryRun, agentState, googleAnalytics }));
}

async function handleSettingsPage(_req, res) {
  const queue = await readQueue();
  const agentState = await readAgentState();
  const googleAnalytics = await getGoogleAnalyticsStatus();
  return sendHtml(res, renderSettingsPage(queue, { dryRun, agentState, googleAnalytics, publishIntervalMinutes }));
}

// ============================================================================
// QUEUE / ITEM HANDLERS
// ============================================================================

async function handleApiCreateItem(req, res) {
  if (!apiToken || req.headers.authorization !== `Bearer ${apiToken}`) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const body = await parseBody(req);
  const items = Array.isArray(body.items) ? body.items : [body];
  const validationErrors = items.flatMap((item, index) => validateApiQueueItem(item, index));

  if (validationErrors.length > 0) {
    return sendJson(res, 400, { error: "Invalid queue items", details: validationErrors });
  }

  const created = await updateQueue((queue) => {
    const createdItems = items.map((item) =>
      createQueueItem({
        ...item,
        status: item.status || "draft",
        source: item.source || "api"
      })
    );
    queue.items.unshift(...createdItems);
    return createdItems;
  });

  return sendJson(res, 201, { items: created });
}

function validateApiQueueItem(item, index) {
  const errors = [];
  const label = `items[${index}]`;

  if (item.type === "reply") {
    if (!item.replyToPostId || item.replyToPostId === "REPLACE_WITH_X_POST_ID") {
      errors.push(`${label}.replyToPostId is required for contextual replies.`);
    }
    if (!item.targetPostUrl) errors.push(`${label}.targetPostUrl is required for contextual replies.`);
    if (!item.targetPostSummary) errors.push(`${label}.targetPostSummary is required for contextual replies.`);
    if (!item.replyRationale) errors.push(`${label}.replyRationale is required for contextual replies.`);
    if (!item.targetAuthor && !item.targetHandle) {
      errors.push(`${label}.targetAuthor or ${label}.targetHandle is required for contextual replies.`);
    }
  }

  if (item.format === "founder-moment") {
    if (item.type && item.type !== "post") {
      errors.push(`${label}.type must be post for founder moment items.`);
    }
    if (!item.visualBrief) errors.push(`${label}.visualBrief is required for founder moment items.`);
    if (!item.captureInstruction) errors.push(`${label}.captureInstruction is required for founder moment items.`);
    if (!item.trendSignal) errors.push(`${label}.trendSignal is required for founder moment items.`);
    if (!item.whyNow) errors.push(`${label}.whyNow is required for founder moment items.`);
  }

  return errors;
}

async function handleLogin(req, res) {
  const body = await parseBody(req);
  if (adminPassword && body.password === adminPassword) {
    const token = signSession("admin");
    res.setHeader("Set-Cookie", `stride_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    return redirect(res, "/");
  }

  return sendHtml(res, renderLogin("Senha inválida."), 401);
}

function handleLogout(res) {
  res.setHeader("Set-Cookie", "stride_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return redirect(res, "/login");
}

async function handleCreateItem(req, res) {
  const body = await parseBody(req);
  await updateQueue((queue) => {
    queue.items.unshift(
      createQueueItem({
        type: body.type,
        format: body.format,
        title: body.title,
        replyToPostId: body.replyToPostId,
        targetAuthor: body.targetAuthor,
        targetHandle: body.targetHandle,
        targetPostUrl: body.targetPostUrl,
        targetPostText: body.targetPostText,
        targetPostSummary: body.targetPostSummary,
        replyRationale: body.replyRationale,
        recommendedSurface: body.recommendedSurface,
        viralThesis: body.viralThesis,
        evidence: body.evidence,
        sourceUrl: body.sourceUrl,
        trendSignal: body.trendSignal,
        whyNow: body.whyNow,
        visualBrief: body.visualBrief,
        captureInstruction: body.captureInstruction,
        postingNotes: body.postingNotes,
        imageAlt: body.imageAlt,
        requiresManualAsset: body.requiresManualAsset === "on",
        requiresManualPublish: body.requiresManualPublish === "on",
        text: body.text,
        source: "dashboard"
      })
    );
  });
  return redirect(res, body._redirect || "/aprovacao");
}

async function handleDeleteRejected(req, res) {
  const body = await parseBody(req);
  await updateQueue((queue) => {
    queue.items = queue.items.filter((item) => item.status !== "rejected");
  });
  return redirect(res, body._redirect || "/aprovacao?aba=arquivo");
}

async function handleRunGrowthAgent(res) {
  await generateDailyGrowthPack({ force: true, reason: "dashboard" });
  return redirect(res, "/");
}

async function handleRunFounderBoardAgent(res) {
  await generateFounderBoard({ force: true, reason: "dashboard" });
  return redirect(res, "/conselho");
}

async function handleRunFounderMomentAgent(res) {
  await generateFounderMoment({ force: true, reason: "dashboard" });
  return redirect(res, "/aprovacao?aba=moments");
}

async function handleRunXEvolutionAgent(res) {
  await generateXAccountEvolution({ force: true, reason: "dashboard" });
  return redirect(res, "/aprendizados");
}

function handleGoogleAuth(req, res) {
  if (!hasGoogleAnalyticsConfig()) {
    return sendText(res, 400, "Google Analytics OAuth is missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_ANALYTICS_PROPERTY_ID.");
  }
  const state = randomBytes(24).toString("base64url");
  const redirectUri = getGoogleRedirectUri(req);
  const authUrl = buildGoogleAuthUrl({ redirectUri, state });
  res.setHeader("Set-Cookie", `google_oauth_state=${signSession(state)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
  return redirect(res, authUrl);
}

async function handleGoogleCallback(req, res, url) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error") || "";
  const cookies = parseCookies(req.headers.cookie || "");
  const expectedState = cookies.google_oauth_state ? verifySession(cookies.google_oauth_state) : "";
  res.setHeader("Set-Cookie", "google_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");

  if (error) return sendText(res, 400, `Google authorization failed: ${error}`);
  if (!state || !expectedState || state !== expectedState) return sendText(res, 400, "Invalid Google OAuth state.");
  if (!code) return sendText(res, 400, "Missing Google OAuth code.");

  await exchangeGoogleCode({ code, redirectUri: getGoogleRedirectUri(req) });
  return redirect(res, "/configuracoes");
}

async function handleItemAction(req, res, id, action) {
  const body = ["update", "reject", "approve"].includes(action) ? await parseBody(req) : {};
  const fallback = body._redirect || "/aprovacao";

  if (action === "delete") {
    await updateQueue((queue) => {
      const index = queue.items.findIndex((candidate) => candidate.id === id);
      if (index === -1) throw new Error(`No item found with id: ${id}`);
      queue.items.splice(index, 1);
    });
    return redirect(res, fallback);
  }

  if (action === "publish") {
    await updateQueue((queue) => {
      const item = findItem(queue, id);
      if (item.status !== "published") {
        item.status = "approved";
        item.updatedAt = new Date().toISOString();
      }
    });
    await publishApproved({ accessToken, dryRun, onlyId: id });
    return redirect(res, fallback);
  }

  if (action === "convert-to-post") {
    await updateQueue((queue) => {
      const item = findItem(queue, id);
      item.type = "post";
      item.status = "draft";
      item.replyToPostId = undefined;
      item.targetAuthor = undefined;
      item.targetHandle = undefined;
      item.targetPostUrl = undefined;
      item.targetPostText = undefined;
      item.targetPostSummary = undefined;
      item.replyRationale = undefined;
      item.error = undefined;
      item.failedAt = undefined;
      item.updatedAt = new Date().toISOString();
    });
    return redirect(res, fallback);
  }

  if (action === "manual-posted") {
    await updateQueue((queue) => {
      const item = findItem(queue, id);
      item.status = "published";
      item.manualPublishedAt = new Date().toISOString();
      item.updatedAt = new Date().toISOString();
      delete item.error;
      delete item.failedAt;
    });
    return redirect(res, fallback);
  }

  await updateQueue((queue) => {
    const item = findItem(queue, id);

    if (action === "update") {
      item.type = body.type || item.type;
      item.format = body.format || item.format;
      item.title = body.title || undefined;
      item.replyToPostId = body.replyToPostId || undefined;
      item.targetAuthor = body.targetAuthor || undefined;
      item.targetHandle = body.targetHandle || undefined;
      item.targetPostUrl = body.targetPostUrl || undefined;
      item.targetPostText = body.targetPostText || undefined;
      item.targetPostSummary = body.targetPostSummary || undefined;
      item.replyRationale = body.replyRationale || undefined;
      item.recommendedSurface = body.recommendedSurface || undefined;
      item.viralThesis = body.viralThesis || undefined;
      item.evidence = body.evidence || undefined;
      item.sourceUrl = body.sourceUrl || undefined;
      item.trendSignal = body.trendSignal || undefined;
      item.whyNow = body.whyNow || undefined;
      item.visualBrief = body.visualBrief || undefined;
      item.captureInstruction = body.captureInstruction || undefined;
      item.postingNotes = body.postingNotes || undefined;
      item.imageAlt = body.imageAlt || undefined;
      item.requiresManualAsset = body.requiresManualAsset === "on" || item.format === "founder-moment";
      item.requiresManualPublish = body.requiresManualPublish === "on" || item.format === "community-post";
      item.text = body.text || "";
    } else if (action === "reject") {
      item.status = "rejected";
      item.rejectionReason = (body.rejectionReason || "").trim() || undefined;
      item.rejectedAt = new Date().toISOString();
    } else {
      item.status = action === "approve" ? "approved" : action;
    }

    item.updatedAt = new Date().toISOString();
  });

  return redirect(res, fallback);
}

async function handlePublishNow(req, res) {
  const body = await parseBody(req);
  await publishApproved({ accessToken, dryRun });
  return redirect(res, body._redirect || "/aprovacao?aba=aprovados");
}

function findItem(queue, id) {
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No item found with id: ${id}`);
  return item;
}

// ============================================================================
// HTTP HELPERS
// ============================================================================

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return raw ? JSON.parse(raw) : {};
  }

  return Object.fromEntries(new URLSearchParams(raw));
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.stride_session;
  if (!token) return false;
  return verifySession(token) === "admin";
}

function signSession(value) {
  const payload = Buffer.from(value).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(token) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  return Buffer.from(payload, "base64url").toString("utf8");
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

// ============================================================================
// QUEUE FILTERS / CLASSIFICATION
// ============================================================================

function classifyItem(item) {
  if (item.format === "founder-moment" || item.requiresManualAsset) return "moments";
  if (item.format === "community-post" || item.requiresManualPublish) return "comunidade";
  if (item.type === "reply") return "replies";
  return "posts";
}

function partitionQueue(queue) {
  const drafts = queue.items.filter((item) => ["draft", "failed"].includes(item.status));
  const approved = queue.items.filter((item) => item.status === "approved");
  const archive = queue.items.filter((item) => ["published", "rejected"].includes(item.status));

  return {
    posts: drafts.filter((item) => classifyItem(item) === "posts"),
    replies: drafts.filter((item) => classifyItem(item) === "replies"),
    comunidade: drafts.filter((item) => classifyItem(item) === "comunidade"),
    moments: drafts.filter((item) => classifyItem(item) === "moments"),
    aprovados: approved,
    arquivo: archive,
    counts: queue.items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {})
  };
}

// ============================================================================
// SHELL — common HTML wrapper
// ============================================================================

function renderShell(activeRoute, options, content) {
  const queueHint = options.queueHint || {};
  return `<!doctype html>
<html lang="pt-BR">
${renderHead(options.title || "Stride OS")}
<body>
  <div class="shell">
    ${renderSidebar(activeRoute, options, queueHint)}
    <div class="main">
      ${renderTopbar(options)}
      <div class="page">
        ${content}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderSidebar(activeRoute, options, queueHint) {
  const items = [
    { id: "hoje", href: ROUTES.hoje, label: "Hoje", icon: iconHome() },
    { id: "aprovacao", href: ROUTES.aprovacao, label: "Aprovação", icon: iconCheck(), badge: queueHint.pending },
    { id: "conselho", href: ROUTES.conselho, label: "Conselho", icon: iconUsers() },
    { id: "aprendizados", href: ROUTES.aprendizados, label: "Aprendizados", icon: iconChart() },
    { id: "configuracoes", href: ROUTES.configuracoes, label: "Configurações", icon: iconCog() }
  ];

  const navHtml = items
    .map(
      (item) => `<a href="${escapeHtml(item.href)}" class="${activeRoute === item.id ? "active" : ""}">
        <span class="nav-icon">${item.icon}</span>
        <span class="nav-label">${escapeHtml(item.label)}</span>
        ${item.badge ? `<span class="nav-badge">${escapeHtml(String(item.badge))}</span>` : ""}
      </a>`
    )
    .join("");

  return `<aside class="sidebar">
    <div class="brand">
      <div class="brand-mark">SO</div>
      <div class="brand-name">Stride OS<small>Central de comando</small></div>
    </div>
    <nav class="nav">${navHtml}</nav>
    <div class="sidebar-footer">
      <span class="mode-chip ${options.dryRun ? "dry" : "live"}">${options.dryRun ? "Modo dry run" : "Modo live"}</span>
      <form method="post" action="/logout"><button class="ghost compact" type="submit">Sair</button></form>
    </div>
  </aside>`;
}

function renderTopbar(options) {
  return `<header class="topbar">
    <div class="breadcrumb">
      <h1>${escapeHtml(options.pageTitle || "")}</h1>
      ${options.pageHint ? `<span class="crumb-sub">· ${escapeHtml(options.pageHint)}</span>` : ""}
    </div>
    <div class="topbar-actions">
      ${options.topbarActions || ""}
    </div>
  </header>`;
}

// ============================================================================
// LOGIN
// ============================================================================

function renderLogin(error) {
  return `<!doctype html>
<html lang="pt-BR">
${renderHead("Entrar")}
<body class="login">
  <main class="login-panel">
    <div class="brand">
      <div class="brand-mark">SO</div>
      <div class="brand-name">Stride OS<small>Central de comando</small></div>
    </div>
    <h2 style="margin-top: 16px; font-size: 18px; font-weight: 600;">Entrar</h2>
    <form method="post" action="/login">
      <label class="field-label">Senha</label>
      <input name="password" type="password" autocomplete="current-password" required autofocus>
      ${error ? `<p class="alert error">${escapeHtml(error)}</p>` : ""}
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`;
}

// ============================================================================
// PAGE: HOJE
// ============================================================================

function renderHomePage(queue, options) {
  const partition = partitionQueue(queue);
  const board = options.agentState?.founderBoard;
  const pendingTotal = partition.posts.length + partition.replies.length + partition.comunidade.length + partition.moments.length;

  const opportunity = board?.marketRadar?.topSignals?.[0];
  const priority = board?.chiefOfStaff?.todayFocus || board?.marketingDirector?.distributionBet;
  const founderMomentSuggestion = partition.moments[0];

  const opportunityCard = opportunity
    ? `<div class="hoje-priority">
        <span class="label">Melhor oportunidade do dia</span>
        <h2>${escapeHtml(opportunity.label || "Sinal sem título")}</h2>
        ${opportunity.evidence ? `<p>${escapeHtml(opportunity.evidence)}</p>` : ""}
        ${opportunity.url ? `<p style="margin-top: 12px;"><a href="${escapeHtml(opportunity.url)}" target="_blank" rel="noreferrer" style="color: var(--info); font-weight: 500;">Abrir fonte →</a></p>` : ""}
      </div>`
    : `<div class="hoje-priority">
        <span class="label">Melhor oportunidade do dia</span>
        <h2 style="color: var(--muted);">Sem sinal capturado ainda</h2>
        <p>Rode o Conselho do Founder para que o Radar de Mercado traga a melhor oportunidade do dia.</p>
        <form method="post" action="/agents/run/board" style="margin-top: 16px;">
          <button type="submit">Gerar conselho agora</button>
        </form>
      </div>`;

  const priorityCard = `<section class="card">
    <div class="card-head">
      <p class="eyebrow">Ação prioritária</p>
      <h3>${escapeHtml(priority || "O Chief of Staff ainda não definiu o foco do dia.")}</h3>
    </div>
    ${board?.chiefOfStaff?.nextMove ? `<p class="subtle">Próximo movimento: ${escapeHtml(board.chiefOfStaff.nextMove)}</p>` : ""}
    <div style="margin-top: 16px;">
      <a href="/conselho" class="btn secondary compact">Ver conselho completo</a>
    </div>
  </section>`;

  const queueRows = `<section class="card">
    <div class="card-head"><h3>Aguardando aprovação</h3></div>
    <div class="queue-summary">
      <a href="/aprovacao?aba=posts"><span>Posts no perfil</span><span class="count">${partition.posts.length}</span></a>
      <a href="/aprovacao?aba=replies"><span>Replies sugeridos</span><span class="count">${partition.replies.length}</span></a>
      <a href="/aprovacao?aba=comunidade"><span>Posts de comunidade</span><span class="count">${partition.comunidade.length}</span></a>
      <a href="/aprovacao?aba=moments"><span>Founder Moments</span><span class="count">${partition.moments.length}</span></a>
      <a href="/aprovacao?aba=aprovados"><span>Aprovados, prontos para publicar</span><span class="count">${partition.aprovados.length}</span></a>
    </div>
  </section>`;

  const founderMomentCard = founderMomentSuggestion
    ? `<section class="card">
        <div class="card-head"><p class="eyebrow">Founder moment sugerido</p><h3>${escapeHtml(founderMomentSuggestion.title || "Foto manual")}</h3></div>
        ${founderMomentSuggestion.visualBrief ? `<p class="subtle" style="margin-bottom: 8px;"><strong style="color: var(--ink);">Foto:</strong> ${escapeHtml(founderMomentSuggestion.visualBrief)}</p>` : ""}
        ${founderMomentSuggestion.whyNow ? `<p class="subtle">${escapeHtml(founderMomentSuggestion.whyNow)}</p>` : ""}
        <div style="margin-top: 12px;">
          <a href="/aprovacao?aba=moments" class="btn secondary compact">Abrir Founder Moments</a>
        </div>
      </section>`
    : "";

  const agentStatus = renderAgentStatusCompact(options.agentState);

  const content = `
    <div class="page-head">
      <p class="eyebrow">${formatToday()}</p>
      <h1>Bom dia, founder.</h1>
      <p>Resumo operacional do dia: o que seus agentes encontraram, o que o conselho recomenda e o que precisa da sua atenção.</p>
    </div>

    <div class="hoje-grid">
      <div class="hoje-main">
        ${opportunityCard}
        <div style="margin-top: 16px;">
          ${priorityCard}
        </div>
      </div>
      <div class="hoje-side">
        ${queueRows}
        ${founderMomentCard}
        ${agentStatus}
      </div>
    </div>
  `;

  return renderShell("hoje", {
    ...options,
    title: "Hoje · Stride OS",
    pageTitle: "Hoje",
    pageHint: pendingTotal > 0 ? `${pendingTotal} item${pendingTotal === 1 ? "" : "s"} aguardando aprovação` : "Fila zerada",
    queueHint: { pending: pendingTotal || undefined },
    topbarActions: pendingTotal > 0 ? `<a href="/aprovacao" class="btn compact">Ir para aprovação</a>` : ""
  }, content);
}

function renderAgentStatusCompact(agentState = {}) {
  const items = [
    { label: "Conselho do Founder", state: agentState.founderBoard, schedule: "08:30" },
    { label: "Pacote de crescimento", state: agentState.growthPack, schedule: "09:00" },
    { label: "Founder moment", state: agentState.founderMoment, schedule: "10:30" },
    { label: "Evolução no X", state: agentState.xAccountEvolution, schedule: "18:00" }
  ];

  const rows = items
    .map(
      (item) => `<p style="display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px;">
        <span>${escapeHtml(item.label)}</span>
        <span style="color: var(--muted);">${item.state?.createdAt ? formatTime(item.state.createdAt) : `agendado ${escapeHtml(item.schedule)}`}</span>
      </p>`
    )
    .join("");

  return `<section class="card">
    <div class="card-head"><h3>Agentes</h3></div>
    ${rows}
  </section>`;
}

// ============================================================================
// PAGE: APROVAÇÃO
// ============================================================================

function renderApprovalPage(queue, options, activeTab) {
  const partition = partitionQueue(queue);
  const validTabs = ["posts", "replies", "comunidade", "moments", "aprovados", "arquivo"];
  const tab = validTabs.includes(activeTab) ? activeTab : "posts";

  const tabLabels = {
    posts: "Posts no perfil",
    replies: "Replies",
    comunidade: "Comunidade",
    moments: "Founder Moments",
    aprovados: "Aprovados",
    arquivo: "Arquivo"
  };

  const tabsHtml = validTabs
    .map((id) => {
      const items = partition[id] || [];
      const isActive = id === tab;
      return `<a href="/aprovacao?aba=${id}" class="${isActive ? "active" : ""}">
        ${escapeHtml(tabLabels[id])}
        <span class="count">${items.length}</span>
      </a>`;
    })
    .join("");

  const items = partition[tab] || [];
  const tabIntros = {
    posts: "Posts originais para o seu perfil. Aprove ou rejeite antes de publicar.",
    replies: "Replies contextuais com contexto do post-alvo. Texto público em inglês.",
    comunidade: "Posts manuais para a comunidade build-in-public. Você publica fora do dashboard e marca como postado.",
    moments: "Ideias de fotos manuais com brief visual e instrução de captura. Você tira a foto, edita a legenda e publica manualmente no X.",
    aprovados: "Itens prontos para publicar. Em modo live, o botão Publicar dispara o post no X.",
    arquivo: "Itens já publicados ou rejeitados. Não interferem mais no fluxo."
  };

  const showComposer = ["posts", "replies"].includes(tab);
  const showDeleteRejected = tab === "arquivo" && partition.arquivo.some((item) => item.status === "rejected");

  const content = `
    <div class="page-head">
      <p class="eyebrow">Aprovação</p>
      <h1>${escapeHtml(tabLabels[tab])}</h1>
      <p>${escapeHtml(tabIntros[tab])}</p>
    </div>

    <div class="tabs">${tabsHtml}</div>

    ${showComposer ? renderComposer() : ""}

    ${
      items.length === 0
        ? `<div class="empty">Nada por aqui ainda.</div>`
        : items.map((item) => renderItem(item, `/aprovacao?aba=${tab}`)).join("")
    }

    ${
      showDeleteRejected
        ? `<form method="post" action="/archive/delete-rejected" onsubmit="return confirm('Excluir todos os rejeitados? Os publicados continuam no arquivo.');" style="margin-top: 16px;">
            <input type="hidden" name="_redirect" value="/aprovacao?aba=arquivo">
            <button class="reject compact" type="submit">Excluir rejeitados</button>
          </form>`
        : ""
    }
  `;

  const pendingTotal = partition.posts.length + partition.replies.length + partition.comunidade.length + partition.moments.length;
  const approvedTotal = partition.aprovados.length;

  return renderShell("aprovacao", {
    ...options,
    title: `${tabLabels[tab]} · Aprovação · Stride OS`,
    pageTitle: "Aprovação",
    pageHint: tab === "aprovados" && approvedTotal > 0 ? `${approvedTotal} pronto${approvedTotal === 1 ? "" : "s"} para publicar` : undefined,
    queueHint: { pending: pendingTotal || undefined },
    topbarActions: tab === "aprovados" && approvedTotal > 0 ? renderPublishAllForm(options.dryRun, "/aprovacao?aba=aprovados") : ""
  }, content);
}

function renderPublishAllForm(dry, redirect) {
  return `<form method="post" action="/publish">
    <input type="hidden" name="_redirect" value="${escapeHtml(redirect)}">
    <button type="submit" class="publish">${dry ? "Testar publicação" : "Publicar todos os aprovados"}</button>
  </form>`;
}

function renderComposer() {
  return `<details class="composer" style="margin-bottom: 20px;">
    <summary>+ Adicionar rascunho manualmente</summary>
    <div class="composer-body">
      <form method="post" action="/items">
        <input type="hidden" name="_redirect" value="/aprovacao">
        <div class="row cols-2">
          <div>
            <label class="field-label">Tipo</label>
            <select name="type"><option value="post">Post</option><option value="reply">Reply</option></select>
          </div>
          <div>
            <label class="field-label">Reply ID (somente reply)</label>
            <input name="replyToPostId" placeholder="ex: 1234567890123456789">
          </div>
        </div>
        <input type="hidden" name="format" value="standard">
        <div>
          <label class="field-label">Texto público (em inglês)</label>
          <textarea name="text" maxlength="280" placeholder="Texto que vai para o X..." required></textarea>
        </div>
        <details class="advanced">
          <summary>Contexto do reply (opcional)</summary>
          <div class="advanced-body">
            <div class="row cols-2">
              <input name="targetAuthor" placeholder="Autor-alvo">
              <input name="targetHandle" placeholder="@handle">
            </div>
            <input name="targetPostUrl" placeholder="URL do post-alvo">
            <textarea name="targetPostSummary" placeholder="Resumo curto do post sendo respondido"></textarea>
            <textarea name="replyRationale" placeholder="Por que vale responder"></textarea>
          </div>
        </details>
        <div><button type="submit">Adicionar rascunho</button></div>
      </form>
    </div>
  </details>`;
}

// ============================================================================
// PAGE: CONSELHO DO FOUNDER
// ============================================================================

function renderCouncilPage(options) {
  const board = options.agentState?.founderBoard;

  if (!board) {
    const content = `
      <div class="page-head">
        <p class="eyebrow">Conselho do Founder</p>
        <h1>Sem memorando ainda</h1>
        <p>O Conselho ainda não foi gerado hoje. Rode-o para que os diretores tragam Radar de Mercado, Marketing, Produto, Chief of Staff e o Experimento de Crescimento.</p>
      </div>
      <form method="post" action="/agents/run/board"><button type="submit">Gerar conselho agora</button></form>
    `;
    return renderShell("conselho", {
      ...options,
      title: "Conselho · Stride OS",
      pageTitle: "Conselho do Founder"
    }, content);
  }

  const personas = [
    { card: board.marketRadar, kind: "radar" },
    { card: board.marketingDirector, kind: "marketing" },
    { card: board.productDirector, kind: "produto" },
    { card: board.chiefOfStaff, kind: "chief" }
  ];

  const personaTitlesPt = {
    radar: "Radar de Mercado",
    marketing: "Diretor de Marketing",
    produto: "Diretor de Produto",
    chief: "Chief of Staff"
  };

  const cardsHtml = personas
    .map((p) => renderCouncilCard(p.card, personaTitlesPt[p.kind]))
    .join("") + renderGrowthExperimentCard(board.growthExperiment);

  const content = `
    <div class="page-head">
      <p class="eyebrow">${escapeHtml(board.date || formatToday())} · gerado ${escapeHtml(formatTime(board.createdAt))}</p>
      <h1>Conselho do Founder</h1>
      <p>${escapeHtml(board.stage || "Memorando operativo do dia.")}${board.intelligence ? ` · Inteligência: ${escapeHtml(board.intelligence)}` : ""}</p>
      ${board.openAIError ? `<p class="alert error" style="margin-top: 12px;">Falha na otimização OpenAI: ${escapeHtml(board.openAIError)}</p>` : ""}
    </div>

    ${renderConnectedSources(board.integrations)}

    <div class="council-grid" style="margin-top: 16px;">
      ${cardsHtml}
    </div>
  `;

  return renderShell("conselho", {
    ...options,
    title: "Conselho · Stride OS",
    pageTitle: "Conselho do Founder",
    pageHint: board.date ? `memorando de ${escapeHtml(board.date)}` : undefined,
    topbarActions: `<form method="post" action="/agents/run/board"><button type="submit" class="secondary compact">Regerar agora</button></form>`
  }, content);
}

function renderConnectedSources(integrations = []) {
  if (!Array.isArray(integrations) || integrations.length === 0) return "";
  return `<section class="card compact">
    <div class="card-head"><p class="eyebrow">Fontes conectadas</p><h3>Sinais que alimentaram este conselho</h3></div>
    <div class="card-grid cols-3">
      ${integrations
        .map(
          (integration) => `<div style="border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: var(--surface-soft);">
            <p style="font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;">${escapeHtml(integration.name || "")}</p>
            <p style="font-weight: 600; font-size: 13px; margin-top: 4px;">${escapeHtml(integration.status || "")}</p>
            ${integration.detail ? `<p style="color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.4;">${escapeHtml(integration.detail)}</p>` : ""}
          </div>`
        )
        .join("")}
    </div>
  </section>`;
}

function renderCouncilCard(card, ptTitle) {
  if (!card || !card.title) return "";
  const fields = [
    ["Resumo", card.summary],
    ["Implicação", card.implication],
    ["Aposta de distribuição", card.distributionBet],
    ["Aposta de produto", card.productBet],
    ["Raciocínio", card.reasoning],
    ["Foco do dia", card.todayFocus],
    ["Risco", card.risk],
    ["Próximo movimento", card.nextMove]
  ];

  return `<article class="card council-card">
    <div class="card-head"><p class="eyebrow">${escapeHtml(ptTitle)}</p><h3>${escapeHtml(card.title)}</h3></div>
    ${fields.map(([label, value]) => renderCouncilField(label, value)).join("")}
    ${renderCouncilList("Sinais", card.topSignals, renderSignalItem)}
    ${renderCouncilList("Ações recomendadas", card.recommendedActions)}
    ${renderCouncilExperiment(card.experiment)}
    ${renderCouncilList("Construir agora", card.roadmapNow)}
    ${renderCouncilList("Depois", card.roadmapLater)}
    ${renderCouncilList("Decisões", card.decisions)}
  </article>`;
}

function renderGrowthExperimentCard(experiment = {}) {
  if (!experiment.title) return "";
  return `<article class="card council-card council-experiment">
    <div class="card-head"><p class="eyebrow">Experimento de Crescimento</p><h3>${escapeHtml(experiment.title)}</h3></div>
    ${renderCouncilField("Nome", experiment.name)}
    ${renderCouncilField("Canal", experiment.channel)}
    ${renderCouncilField("Hipótese", experiment.hypothesis)}
    ${renderCouncilField("Ação", experiment.action)}
    ${renderCouncilField("Evidência", experiment.evidence)}
    ${renderCouncilField("Métrica de sucesso", experiment.successMetric)}
    ${experiment.sourceUrl ? `<p class="field"><span>Fonte</span><a href="${escapeHtml(experiment.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(experiment.sourceUrl)}</a></p>` : ""}
  </article>`;
}

function renderCouncilField(label, value) {
  if (!value) return "";
  return `<p class="field"><span>${escapeHtml(label)}</span>${escapeHtml(value)}</p>`;
}

function renderCouncilList(label, values, renderer) {
  if (!Array.isArray(values) || values.length === 0) return "";
  const render = renderer || ((value) => `<li>${escapeHtml(value)}</li>`);
  return `<div class="list">
    <span>${escapeHtml(label)}</span>
    <ul>${values.map((v) => render(v)).join("")}</ul>
  </div>`;
}

function renderSignalItem(signal = {}) {
  const source = signal.url
    ? `<a href="${escapeHtml(signal.url)}" target="_blank" rel="noreferrer">${escapeHtml(signal.source || "fonte")}</a>`
    : escapeHtml(signal.source || "fonte");
  return `<li><strong>${escapeHtml(signal.label || "")}</strong><small>${source}${signal.evidence ? ` · ${escapeHtml(signal.evidence)}` : ""}</small></li>`;
}

function renderCouncilExperiment(experiment) {
  if (!experiment) return "";
  return `<div class="subcard">
    <strong>${escapeHtml(experiment.name || "Experimento")}</strong>
    ${renderCouncilField("Hipótese", experiment.hypothesis)}
    ${renderCouncilField("Métrica", experiment.metric)}
    ${renderCouncilField("Duração", experiment.duration)}
  </div>`;
}

// ============================================================================
// PAGE: APRENDIZADOS
// ============================================================================

function renderLearningsPage(queue, options) {
  const stats = computeLearningStats(queue);
  const published = queue.items.filter((i) => i.status === "published").sort(compareByDateDesc);
  const rejected = queue.items.filter((i) => i.status === "rejected").sort(compareByDateDesc);
  const topThemes = extractTopThemes(published, 5);
  const patterns = computePatterns(queue);
  const xEvolution = options.agentState?.xAccountEvolution;

  const content = `
    <div class="page-head">
      <p class="eyebrow">Aprendizados</p>
      <h1>O que está funcionando</h1>
      <p>Performance, padrões e recomendações com base no que foi publicado e rejeitado. Os dados crescem conforme você usa.</p>
    </div>

    <div class="metric-grid">
      <div class="metric"><div class="label">Publicados</div><div class="value">${stats.published}</div><div class="delta">${stats.publishedThisWeek} esta semana</div></div>
      <div class="metric"><div class="label">Aprovação</div><div class="value">${stats.approvalRate}%</div><div class="delta">${stats.approved} aprovados de ${stats.reviewed} revisados</div></div>
      <div class="metric"><div class="label">Rejeitados</div><div class="value">${stats.rejected}</div><div class="delta">${stats.rejectionRate}% do total revisado</div></div>
      <div class="metric"><div class="label">Falhas de publicação</div><div class="value">${stats.failed}</div><div class="delta">${stats.failed > 0 ? "Confira os erros" : "Sem falhas"}</div></div>
    </div>

    ${renderXEvolutionCard(xEvolution)}

    <div class="card-grid cols-2" style="gap: 16px;">
      <section class="card">
        <div class="card-head"><h3>Top temas dos publicados</h3><p class="subtle">Palavras mais frequentes nos posts já publicados.</p></div>
        ${
          topThemes.length === 0
            ? `<p class="subtle">Sem publicações suficientes para extrair temas.</p>`
            : `<div class="row" style="gap: 8px;">${topThemes
                .map(
                  (theme) => `<div style="display: flex; justify-content: space-between; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft);">
                    <span style="font-weight: 500;">${escapeHtml(theme.word)}</span>
                    <span class="subtle" style="font-size: 12px;">${theme.count} post${theme.count === 1 ? "" : "s"}</span>
                  </div>`
                )
                .join("")}</div>`
        }
      </section>

      <section class="card">
        <div class="card-head"><h3>Padrões aprendidos</h3><p class="subtle">Como cada tipo de conteúdo se comporta no funil.</p></div>
        ${
          patterns.length === 0
            ? `<p class="subtle">Volume ainda baixo. Os padrões aparecem após algumas dezenas de itens.</p>`
            : `<div class="row" style="gap: 6px;">${patterns
                .map(
                  (p) => `<div style="display: flex; justify-content: space-between; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft);">
                    <span style="font-weight: 500;">${escapeHtml(p.label)}</span>
                    <span class="subtle" style="font-size: 12px;">${escapeHtml(p.detail)}</span>
                  </div>`
                )
                .join("")}</div>`
        }
      </section>
    </div>

    <section class="card" style="margin-top: 16px;">
      <div class="card-head"><h3>Posts publicados</h3><p class="subtle">Histórico recente. Os IDs do X permitem cruzar com métricas externas.</p></div>
      ${
        published.length === 0
          ? `<p class="subtle">Nenhum post publicado ainda.</p>`
          : published
              .slice(0, 12)
              .map(
                (item) => `<div style="padding: 12px 0; border-bottom: 1px solid var(--line);">
                  <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px;">
                    <span class="pill type">${escapeHtml(typeLabel(item))}</span>
                    <span class="subtle" style="font-size: 12px;">${escapeHtml(formatDate(item.updatedAt))}</span>
                  </div>
                  <p style="font-size: 13.5px; line-height: 1.5; color: var(--ink-soft);">${escapeHtml(truncate(item.text, 220))}</p>
                  ${item.xPostId ? `<p class="subtle" style="font-size: 11.5px; margin-top: 6px;">X post ID: ${escapeHtml(item.xPostId)}</p>` : ""}
                  ${item.manualPublishedAt ? `<p class="subtle" style="font-size: 11.5px; margin-top: 6px;">Marcado como postado manualmente.</p>` : ""}
                </div>`
              )
              .join("")
      }
    </section>

    <section class="card" style="margin-top: 16px;">
      <div class="card-head"><h3>O que foi rejeitado</h3><p class="subtle">Itens com motivo registrado ajudam a IA a calibrar próximas sugestões.</p></div>
      ${
        rejected.length === 0
          ? `<p class="subtle">Nenhum item rejeitado.</p>`
          : rejected
              .slice(0, 10)
              .map(
                (item) => `<div style="padding: 12px 0; border-bottom: 1px solid var(--line);">
                  <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px;">
                    <span class="pill type">${escapeHtml(typeLabel(item))}</span>
                    <span class="subtle" style="font-size: 12px;">${escapeHtml(formatDate(item.rejectedAt || item.updatedAt))}</span>
                  </div>
                  <p style="font-size: 13.5px; line-height: 1.5; color: var(--ink-soft);">${escapeHtml(truncate(item.text, 200))}</p>
                  ${item.rejectionReason ? `<p style="margin-top: 6px; padding: 8px 10px; background: var(--danger-soft); border-radius: 6px; font-size: 12.5px; color: var(--danger);"><strong>Motivo:</strong> ${escapeHtml(item.rejectionReason)}</p>` : `<p class="subtle" style="font-size: 12px; margin-top: 6px;">Sem motivo registrado.</p>`}
                </div>`
              )
              .join("")
      }
    </section>
  `;

  const partition = partitionQueue(queue);
  const pendingTotal = partition.posts.length + partition.replies.length + partition.comunidade.length + partition.moments.length;

  return renderShell("aprendizados", {
    ...options,
    title: "Aprendizados · Stride OS",
    pageTitle: "Aprendizados",
    pageHint: stats.published > 0 ? `${stats.published} publicado${stats.published === 1 ? "" : "s"} no total` : "histórico em construção",
    queueHint: { pending: pendingTotal || undefined }
  }, content);
}

function renderXEvolutionCard(report) {
  const metrics = report?.metrics || {};
  const deltas = report?.deltas || {};
  const topPosts = Array.isArray(report?.topPosts) ? report.topPosts : [];
  const recommendations = Array.isArray(report?.recommendations) ? report.recommendations : [];

  return `<section class="card" style="margin-bottom: 16px;">
    <div class="card-head">
      <div>
        <h3>Evolução da conta no X</h3>
        <p class="subtle">${report?.createdAt ? `Último snapshot em ${formatDate(report.createdAt)} às ${formatTime(report.createdAt)}.` : "Ainda sem snapshot. Rode o agente para criar a primeira linha de base."}</p>
      </div>
      <form method="post" action="/agents/run/x-evolution">
        <button type="submit" class="secondary compact">Rodar agora</button>
      </form>
    </div>
    ${
      report
        ? `<p style="font-size: 13.5px; line-height: 1.5; color: var(--ink-soft); margin-bottom: 12px;">${escapeHtml(report.summary || "")}</p>
          <div class="metric-grid" style="margin-bottom: 12px;">
            <div class="metric"><div class="label">Seguidores</div><div class="value">${escapeHtml(formatCount(metrics.followers))}</div><div class="delta">${escapeHtml(formatDelta(deltas.followers))}</div></div>
            <div class="metric"><div class="label">Posts totais</div><div class="value">${escapeHtml(formatCount(metrics.posts))}</div><div class="delta">${escapeHtml(formatDelta(deltas.posts))}</div></div>
            <div class="metric"><div class="label">Seguindo</div><div class="value">${escapeHtml(formatCount(metrics.following))}</div><div class="delta">${escapeHtml(formatDelta(deltas.following))}</div></div>
            <div class="metric"><div class="label">Listas</div><div class="value">${escapeHtml(formatCount(metrics.listed))}</div><div class="delta">${escapeHtml(formatDelta(deltas.listed))}</div></div>
          </div>
          ${
            topPosts.length === 0
              ? `<p class="subtle">Sem posts publicados com métricas do X ainda.</p>`
              : `<div class="row" style="gap: 8px;">${topPosts
                  .map(
                    (post) => `<div style="padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft);">
                      <div style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px;">
                        <strong style="font-size: 13px;">Score ${escapeHtml(formatCount(post.score))}</strong>
                        <a href="${escapeHtml(post.url || "#")}" target="_blank" rel="noreferrer" style="font-size: 12px;">Abrir no X</a>
                      </div>
                      <p style="font-size: 13px; line-height: 1.45; color: var(--ink-soft);">${escapeHtml(truncate(post.text || "", 180))}</p>
                    </div>`
                  )
                  .join("")}</div>`
          }
          ${recommendations.length ? `<div style="margin-top: 12px;">${renderCouncilList("Recomendações", recommendations)}</div>` : ""}`
        : `<p class="subtle">O agente vai comparar seguidores e posts publicados entre snapshots diários.</p>`
    }
  </section>`;
}

function formatCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? new Intl.NumberFormat("pt-BR").format(number) : "0";
}

function formatDelta(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number === 0) return "sem variação";
  return `${number > 0 ? "+" : ""}${formatCount(number)} desde o último snapshot`;
}

function computeLearningStats(queue) {
  const counts = queue.items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { total: 0 }
  );

  const reviewed = (counts.approved || 0) + (counts.rejected || 0) + (counts.published || 0);
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const publishedThisWeek = queue.items.filter(
    (i) => i.status === "published" && i.updatedAt && new Date(i.updatedAt).getTime() > oneWeekAgo
  ).length;

  return {
    total: counts.total,
    published: counts.published || 0,
    approved: counts.approved || 0,
    rejected: counts.rejected || 0,
    failed: counts.failed || 0,
    draft: counts.draft || 0,
    reviewed,
    approvalRate: reviewed > 0 ? Math.round(((counts.approved || 0) + (counts.published || 0)) / reviewed * 100) : 0,
    rejectionRate: reviewed > 0 ? Math.round((counts.rejected || 0) / reviewed * 100) : 0,
    publishedThisWeek
  };
}

const STOPWORDS_PT_EN = new Set([
  "the", "and", "you", "for", "with", "this", "that", "your", "from", "are", "not", "but", "what", "when", "have", "was", "all", "one", "out", "get", "got", "can", "will", "just", "like", "than", "into", "more", "they", "their", "them", "about", "would", "could", "should", "some", "any", "who", "how", "why", "where", "which", "now", "also", "most",
  "que", "para", "com", "por", "uma", "dos", "das", "como", "mais", "muito", "isso", "esse", "essa", "ele", "ela", "você", "voce", "seu", "sua", "ser", "estar", "tem", "tinha", "está", "esta", "são", "sao", "foi", "vai", "vão", "vao", "este", "estes", "essas", "esses", "tudo", "todo", "toda", "minha", "meu", "nosso", "nossos",
  "https", "http", "com", "www"
]);

function extractTopThemes(items, limit) {
  const counter = new Map();
  for (const item of items) {
    if (!item.text) continue;
    const words = item.text
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúãõâêîôûç\s]/gi, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !STOPWORDS_PT_EN.has(w));
    const seen = new Set();
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      counter.set(w, (counter.get(w) || 0) + 1);
    }
  }
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .filter(([, count]) => count >= 2)
    .map(([word, count]) => ({ word, count }));
}

function computePatterns(queue) {
  const patterns = [];
  const byType = { posts: { total: 0, published: 0, rejected: 0 }, replies: { total: 0, published: 0, rejected: 0 }, comunidade: { total: 0, published: 0, rejected: 0 }, moments: { total: 0, published: 0, rejected: 0 } };

  for (const item of queue.items) {
    const cat = classifyItem(item);
    if (!byType[cat]) continue;
    byType[cat].total += 1;
    if (item.status === "published") byType[cat].published += 1;
    if (item.status === "rejected") byType[cat].rejected += 1;
  }

  const labelMap = { posts: "Posts no perfil", replies: "Replies", comunidade: "Comunidade", moments: "Founder Moments" };
  for (const [cat, counts] of Object.entries(byType)) {
    if (counts.total < 2) continue;
    const rate = counts.total > 0 ? Math.round((counts.published / counts.total) * 100) : 0;
    patterns.push({
      label: labelMap[cat],
      detail: `${counts.published}/${counts.total} publicados · ${rate}% conversão`
    });
  }

  return patterns;
}

// ============================================================================
// PAGE: CONFIGURAÇÕES
// ============================================================================

function renderSettingsPage(_queue, options) {
  const integrations = describeIntegrations(options);
  const google = options.googleAnalytics || {};

  const integrationCards = integrations
    .map(
      (i) => `<div style="display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface);">
        <div>
          <p style="font-weight: 600; font-size: 14px;">${escapeHtml(i.name)}</p>
          <p class="subtle" style="font-size: 12.5px; margin-top: 4px; line-height: 1.4;">${escapeHtml(i.description)}</p>
        </div>
        <div style="text-align: right;">
          <span class="pill ${i.statusClass}">${escapeHtml(i.status)}</span>
        </div>
      </div>`
    )
    .join("");

  const content = `
    <div class="page-head">
      <p class="eyebrow">Configurações</p>
      <h1>Operação e integrações</h1>
      <p>Conecte fontes, ajuste agentes e revise o modo de operação. Variáveis de ambiente são gerenciadas no Render.</p>
    </div>

    <section class="card">
      <div class="card-head">
        <h3>Modo de operação</h3>
        <p class="subtle">${options.dryRun ? "Em dry run nada é publicado no X. Use para testar aprovações sem risco." : "Publicação real está ligada. Posts aprovados podem ir ao X."}</p>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span class="pill ${options.dryRun ? "draft" : "approved"}" style="font-size: 13px;">${options.dryRun ? "Dry run" : "Live"}</span>
        <span class="subtle" style="font-size: 12.5px;">Configure <code style="background: var(--surface-soft); padding: 1px 5px; border-radius: 4px; font-size: 12px;">DRY_RUN</code> nas variáveis do Render.</span>
      </div>
    </section>

    <section class="card" style="margin-top: 16px;">
      <div class="card-head">
        <h3>Integrações</h3>
        <p class="subtle">Cada integração alimenta os diretores ou habilita a publicação. Sem chave configurada, o sistema cai num fallback baseado em regras.</p>
      </div>
      <div class="row" style="gap: 8px;">
        ${integrationCards}
      </div>
      ${
        google.configured
          ? `<div style="margin-top: 16px; display: flex; gap: 8px;">
              <form method="post" action="/auth/google">
                <button type="submit" class="secondary compact">${google.connected ? "Reconectar Google Analytics" : "Conectar Google Analytics"}</button>
              </form>
            </div>`
          : ""
      }
    </section>

    <section class="card" style="margin-top: 16px;">
      <div class="card-head">
        <h3>Agentes do Render</h3>
        <p class="subtle">Os agentes rodam dentro do Render no horário programado. Você pode forçar agora, sem afetar o agendamento.</p>
      </div>
      <div class="row" style="gap: 10px;">
        ${renderAgentRow("Conselho do Founder", options.agentState?.founderBoard, "08:30 BRT", "/agents/run/board")}
        ${renderAgentRow("Pacote de crescimento", options.agentState?.growthPack, "09:00 BRT", "/agents/run/growth")}
        ${renderAgentRow("Founder moment", options.agentState?.founderMoment, "10:30 BRT", "/agents/run/founder-moment")}
        ${renderAgentRow("Evolução da conta no X", options.agentState?.xAccountEvolution, "18:00 BRT", "/agents/run/x-evolution")}
      </div>
    </section>

    <section class="card" style="margin-top: 16px;">
      <div class="card-head">
        <h3>Publicação automática</h3>
        <p class="subtle">${options.publishIntervalMinutes > 0 ? `O publisher roda a cada ${options.publishIntervalMinutes} minuto${options.publishIntervalMinutes === 1 ? "" : "s"}.` : "Publicação automática desligada. Defina PUBLISH_INTERVAL_MINUTES para ativar."}</p>
      </div>
    </section>
  `;

  return renderShell("configuracoes", {
    ...options,
    title: "Configurações · Stride OS",
    pageTitle: "Configurações"
  }, content);
}

function renderAgentRow(label, state, schedule, runUrl) {
  const last = state?.createdAt ? `${formatDate(state.createdAt)} às ${formatTime(state.createdAt)}` : "ainda não rodou";
  return `<div style="display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft);">
    <div>
      <p style="font-weight: 500; font-size: 13.5px;">${escapeHtml(label)}</p>
      <p class="subtle" style="font-size: 12px; margin-top: 2px;">Agendado ${escapeHtml(schedule)} · última execução ${escapeHtml(last)}</p>
    </div>
    <form method="post" action="${escapeHtml(runUrl)}">
      <button type="submit" class="secondary compact">Rodar agora</button>
    </form>
  </div>`;
}

function describeIntegrations(_options) {
  const env = process.env;
  const x = !!env.X_USER_ACCESS_TOKEN && !!env.X_REFRESH_TOKEN && !!env.X_CLIENT_ID && !!env.X_CLIENT_SECRET;
  const openai = !!env.OPENAI_API_KEY;
  const plausible = !!env.PLAUSIBLE_API_KEY && !!env.PLAUSIBLE_SITE_ID;
  const posthog = !!env.POSTHOG_PERSONAL_API_KEY && !!env.POSTHOG_PROJECT_ID;
  const redditConfigured = !!env.REDDIT_SUBREDDITS;
  const targetsConfigured = !!env.TARGET_X_HANDLES;
  const defaultRedditSubreddits = "SaaS,startups,Entrepreneur,SideProject,indiehackers";
  const defaultTargetHandles = "gregisenberg,noahkagan,george__mack,buildinpublic,openai,perplexity_ai,AnthropicAI";
  const redditSubreddits = env.REDDIT_SUBREDDITS || defaultRedditSubreddits;
  const targetHandles = env.TARGET_X_HANDLES || defaultTargetHandles;
  const google = _options.googleAnalytics || {};

  return [
    {
      name: "X (Twitter)",
      description: "OAuth 2.0 com tweet.read, tweet.write, users.read e offline.access. Usado para publicar e ler métricas dos posts.",
      ...statusOf(x)
    },
    {
      name: "OpenAI",
      description: env.OPENAI_MODEL ? `Modelo ${env.OPENAI_MODEL}. Estrutura saída via Responses API.` : "Estrutura saída via Responses API. Sem chave, cai em fallback baseado em regras.",
      ...statusOf(openai)
    },
    {
      name: "Plausible",
      description: env.PLAUSIBLE_SITE_ID ? `Site ${env.PLAUSIBLE_SITE_ID}. Sinais de tráfego e conversão.` : "Sinais de tráfego e conversão da landing.",
      ...statusOf(plausible)
    },
    {
      name: "PostHog",
      description: env.POSTHOG_HOST ? `Host ${env.POSTHOG_HOST}. Sinais de produto e funil.` : "Sinais de produto e funil.",
      ...statusOf(posthog)
    },
    {
      name: "Reddit",
      description: `${redditConfigured ? "Lista configurada" : "Lista padrão sem OAuth"}: r/${redditSubreddits.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 5).join(", r/")}. Usado como radar público; pode ficar limitado por bloqueio ou rate limit.`,
      status: redditConfigured ? "Configurado" : "Ativo público",
      statusClass: redditConfigured ? "approved" : "published"
    },
    {
      name: "Contas no X (radar)",
      description: `${targetsConfigured ? "Lista configurada" : "Lista padrão"}: ${targetHandles.split(",").map((s) => `@${s.trim().replace(/^@/, "")}`).filter(Boolean).slice(0, 7).join(", ")}. Usa o acesso do X para buscar sinais recentes.`,
      status: x ? (targetsConfigured ? "Conectado" : "Ativo padrão") : "Precisa do X",
      statusClass: x ? (targetsConfigured ? "approved" : "published") : "failed"
    },
    {
      name: "Google Analytics",
      description: google.connected
        ? `GA4 ${google.propertyId} conectado${google.connectedAt ? ` em ${formatTime(google.connectedAt)}` : ""}.`
        : google.configured
          ? "Pronto para conectar via OAuth."
          : "Adicione GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_ANALYTICS_PROPERTY_ID no Render.",
      status: google.connected ? "Conectado" : google.configured ? "Pronto" : "Não configurado",
      statusClass: google.connected ? "approved" : google.configured ? "type" : "draft"
    }
  ];
}

function statusOf(ok) {
  return ok
    ? { status: "Conectado", statusClass: "approved" }
    : { status: "Não configurado", statusClass: "draft" };
}

// ============================================================================
// ITEM RENDERING (shared by /aprovacao)
// ============================================================================

function renderItem(item, redirectTo) {
  const charCount = item.text?.length || 0;
  const title = typeLabel(item);
  const actionHint = getActionHint(item);

  return `<article class="item ${escapeHtml(item.status)}">
    <div class="item-head">
      <div class="meta">
        <span class="pill ${escapeHtml(item.status)}">${escapeHtml(statusLabelPt(item.status))}</span>
        <span class="pill type">${escapeHtml(title)}</span>
        ${item.title ? `<span class="item-title">${escapeHtml(item.title)}</span>` : ""}
      </div>
      <span class="chars">${charCount}/280</span>
    </div>
    <p class="action-hint">${escapeHtml(actionHint)}</p>

    ${item.error ? `<p class="alert error">${escapeHtml(item.error)}</p>` : ""}
    ${item.xPostId ? `<p class="alert success">X post ID: ${escapeHtml(item.xPostId)}</p>` : ""}
    ${item.manualPublishedAt ? `<p class="alert info">Marcado como postado manualmente.</p>` : ""}
    ${item.rejectionReason ? `<p class="alert error">Motivo da rejeição: ${escapeHtml(item.rejectionReason)}</p>` : ""}

    ${renderStrategyContext(item)}
    ${renderFounderMomentContext(item)}
    ${renderTargetContext(item)}

    <form method="post" action="/items/${encodeURIComponent(item.id)}/update">
      <input type="hidden" name="_redirect" value="${escapeHtml(redirectTo || "/aprovacao")}">
      <label class="field-label">Texto público (em inglês)</label>
      <textarea name="text" maxlength="280" ${item.status === "published" ? "readonly" : ""}>${escapeHtml(item.text || "")}</textarea>
      ${renderRejectionReasonField(item)}
      ${renderAdvancedFields(item)}
      <div class="actions" style="margin-top: 12px;">
        ${renderActions(item)}
      </div>
    </form>
  </article>`;
}

function renderRejectionReasonField(item) {
  if (!["draft", "failed", "approved"].includes(item.status)) return "";
  return `<details class="advanced" style="margin-top: 10px;">
    <summary>Motivo da rejeição (opcional, ajuda a IA a calibrar)</summary>
    <div class="advanced-body">
      <textarea name="rejectionReason" placeholder="Ex.: tom errado, fora de marca, repetitivo, sem evidência..."></textarea>
      <p class="subtle" style="font-size: 12px;">Aplicado apenas se você clicar em Rejeitar.</p>
    </div>
  </details>`;
}

function renderAdvancedFields(item) {
  return `<details class="advanced" style="margin-top: 10px;">
    <summary>${item.format === "founder-moment" ? "Editar brief da foto" : item.type === "reply" ? "Editar contexto do reply" : "Configurações avançadas"}</summary>
    <div class="advanced-body">
      <div class="row cols-2">
        <select name="type">
          <option value="post" ${item.type === "post" ? "selected" : ""}>Post</option>
          <option value="reply" ${item.type === "reply" ? "selected" : ""}>Reply</option>
        </select>
        <select name="format">
          <option value="standard" ${!["founder-moment", "community-post"].includes(item.format) ? "selected" : ""}>Padrão</option>
          <option value="founder-moment" ${item.format === "founder-moment" ? "selected" : ""}>Founder Moment</option>
          <option value="community-post" ${item.format === "community-post" ? "selected" : ""}>Comunidade</option>
        </select>
      </div>
      <label class="check-row" style="display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px;">
        <input type="checkbox" name="requiresManualAsset" ${item.requiresManualAsset ? "checked" : ""} style="width: auto;">
        Precisa de imagem/vídeo manual
      </label>
      <label class="check-row" style="display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px;">
        <input type="checkbox" name="requiresManualPublish" ${item.requiresManualPublish ? "checked" : ""} style="width: auto;">
        Precisa publicação manual
      </label>
      <div class="row cols-2">
        <input name="replyToPostId" value="${escapeHtml(item.replyToPostId || "")}" placeholder="Reply post ID">
        <input name="title" value="${escapeHtml(item.title || "")}" placeholder="Título interno">
      </div>
      <div class="row cols-2">
        <input name="targetAuthor" value="${escapeHtml(item.targetAuthor || "")}" placeholder="Autor-alvo">
        <input name="targetHandle" value="${escapeHtml(item.targetHandle || "")}" placeholder="@handle">
      </div>
      <input name="targetPostUrl" value="${escapeHtml(item.targetPostUrl || "")}" placeholder="URL do post-alvo">
      <textarea name="targetPostSummary" placeholder="Resumo do post sendo respondido">${escapeHtml(item.targetPostSummary || "")}</textarea>
      <textarea name="targetPostText" placeholder="Texto/contexto original">${escapeHtml(item.targetPostText || "")}</textarea>
      <textarea name="replyRationale" placeholder="Por que vale responder">${escapeHtml(item.replyRationale || "")}</textarea>
      <input name="recommendedSurface" value="${escapeHtml(item.recommendedSurface || "")}" placeholder="Superfície recomendada">
      <input name="sourceUrl" value="${escapeHtml(item.sourceUrl || "")}" placeholder="URL da fonte">
      <textarea name="viralThesis" placeholder="Tese viral / por que pode escalar">${escapeHtml(item.viralThesis || "")}</textarea>
      <textarea name="evidence" placeholder="Evidência por trás da recomendação">${escapeHtml(item.evidence || "")}</textarea>
      <textarea name="trendSignal" placeholder="Sinal de tendência">${escapeHtml(item.trendSignal || "")}</textarea>
      <textarea name="whyNow" placeholder="Por que vale postar agora">${escapeHtml(item.whyNow || "")}</textarea>
      <textarea name="visualBrief" placeholder="Foto/vídeo a capturar">${escapeHtml(item.visualBrief || "")}</textarea>
      <textarea name="captureInstruction" placeholder="Como fotografar">${escapeHtml(item.captureInstruction || "")}</textarea>
      <textarea name="postingNotes" placeholder="Nota para a publicação">${escapeHtml(item.postingNotes || "")}</textarea>
      <textarea name="imageAlt" placeholder="Texto alternativo da imagem">${escapeHtml(item.imageAlt || "")}</textarea>
    </div>
  </details>`;
}

function renderStrategyContext(item) {
  if (!item.recommendedSurface && !item.viralThesis && !item.evidence && !item.trendSignal && !item.sourceUrl) return "";
  return `<section class="context">
    <div class="context-grid">
      ${renderContextField("Superfície recomendada", item.recommendedSurface)}
      ${renderContextField("Tese viral", item.viralThesis)}
      ${renderContextField("Evidência", item.evidence)}
      ${renderContextField("Sinal de tendência", item.trendSignal)}
      ${item.sourceUrl ? `<p><span>Fonte</span><a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer" style="color: var(--info);">${escapeHtml(item.sourceUrl)}</a></p>` : ""}
    </div>
  </section>`;
}

function renderFounderMomentContext(item) {
  if (item.format !== "founder-moment" && !item.requiresManualAsset) return "";
  return `<section class="context" style="background: var(--warning-soft); border-color: #fde68a;">
    <div class="context-grid">
      ${renderContextField("Sinal de tendência", item.trendSignal)}
      ${renderContextField("Por que agora", item.whyNow)}
      ${renderContextField("Foto a tirar", item.visualBrief)}
      ${renderContextField("Como fotografar", item.captureInstruction)}
      ${renderContextField("Nota de publicação", item.postingNotes)}
      ${renderContextField("Texto alternativo", item.imageAlt)}
    </div>
  </section>`;
}

function renderTargetContext(item) {
  if (item.type !== "reply") return "";

  const author = [item.targetAuthor, item.targetHandle].filter(Boolean).join(" ");
  const hasContext = item.targetPostUrl && item.targetPostSummary && item.replyRationale && (item.targetAuthor || item.targetHandle);

  return `<section class="context ${hasContext ? "" : "missing"}">
    <div style="display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 8px;">
      <strong>${hasContext ? "Post-alvo" : "Contexto do reply faltando"}</strong>
      ${item.targetPostUrl ? `<a href="${escapeHtml(item.targetPostUrl)}" target="_blank" rel="noreferrer" style="color: var(--info); font-size: 12.5px;">Abrir post →</a>` : ""}
    </div>
    ${hasContext ? "" : `<p><span>Faltando contexto</span>Adicione post original, autor, resumo e motivo antes de aprovar.</p>`}
    ${author ? `<p><span>Autor</span>${escapeHtml(author)}</p>` : ""}
    ${item.targetPostSummary ? `<p><span>Resumo</span>${escapeHtml(item.targetPostSummary)}</p>` : ""}
    ${item.targetPostText ? `<blockquote>${escapeHtml(item.targetPostText)}</blockquote>` : ""}
    ${item.replyRationale ? `<p><span>Por que responder</span>${escapeHtml(item.replyRationale)}</p>` : ""}
  </section>`;
}

function renderContextField(label, value) {
  if (!value) return "";
  return `<p><span>${escapeHtml(label)}</span>${escapeHtml(value)}</p>`;
}

function renderActions(item) {
  if (item.status === "published") return "";

  const save = `<button class="secondary compact" type="submit">Salvar</button>`;
  const approve = renderAction(item, "approve", "Aprovar", "approve");
  const publish = renderAction(item, "publish", "Publicar agora", "publish");
  const reject = renderAction(item, "reject", "Rejeitar", "reject");
  const draft = renderAction(item, "draft", "Voltar para rascunho", "draft");
  const remove = renderAction(item, "delete", "Excluir", "delete");
  const convertToPost = renderAction(item, "convert-to-post", "Converter em post", "convert-to-post");
  const manualPosted = renderAction(item, "manual-posted", "Marcar como postado", "manual-posted");

  if (item.format === "founder-moment" || item.format === "community-post" || item.requiresManualAsset || item.requiresManualPublish) {
    if (item.status === "rejected") return `${draft}${remove}`;
    return `${save}${manualPosted}${reject}`;
  }

  if (item.status === "approved") return `${save}${publish}${draft}${reject}`;
  if (item.status === "rejected") return `${draft}${remove}`;
  if (item.status === "failed") return `${save}${item.type === "reply" ? convertToPost : ""}${approve}${reject}${remove}`;
  return `${save}${approve}${reject}`;
}

function renderAction(item, action, label, klass) {
  return `<button formmethod="post" formaction="/items/${encodeURIComponent(item.id)}/${action}" class="${klass} compact" type="submit">${escapeHtml(label)}</button>`;
}

// ============================================================================
// LABELS / FORMATTERS
// ============================================================================

function typeLabel(item) {
  if (item.format === "founder-moment") return "Founder Moment";
  if (item.format === "community-post") return "Comunidade";
  if (item.type === "reply") return "Reply";
  return "Post";
}

function statusLabelPt(status) {
  const map = { draft: "rascunho", approved: "aprovado", published: "publicado", rejected: "rejeitado", failed: "falhou" };
  return map[status] || status;
}

function getActionHint(item) {
  if (item.format === "founder-moment" && item.status === "published") return "Imagem manual marcada como postada.";
  if (item.format === "founder-moment") return "Tire a foto sugerida, ajuste a legenda e poste manualmente no X.";
  if (item.format === "community-post") return "Poste manualmente na comunidade build-in-public e marque como postado.";
  if (item.status === "approved") return "Pronto. Publique agora, volte para rascunho ou rejeite.";
  if (item.status === "failed") return "Falhou. Revise o erro, ajuste o texto e aprove de novo.";
  if (item.status === "rejected") return "Rejeitado. Volte para rascunho ou exclua da fila.";
  if (item.status === "published") return "Publicado no X.";
  if (item.type === "reply") return "Confira o post-alvo e o reply sugerido antes de aprovar.";
  return "Revise o texto público antes de aprovar ou rejeitar.";
}

function compareByDateDesc(a, b) {
  return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
}

function truncate(text, max) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "short"
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatToday() {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      weekday: "long",
      day: "2-digit",
      month: "long"
    }).format(new Date());
  } catch {
    return "";
  }
}

// ============================================================================
// ICONS (inline SVG)
// ============================================================================

function iconHome() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7l6-5 6 5v6.5a1 1 0 01-1 1h-3v-4H6v4H3a1 1 0 01-1-1V7z"/></svg>`;
}
function iconCheck() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5l3.5 3.5L14 4"/></svg>`;
}
function iconUsers() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><path d="M2 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4"/><circle cx="11.5" cy="6.5" r="2"/><path d="M10 13.5c0-2.2 1.6-3.5 3.5-3.5"/></svg>`;
}
function iconChart() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h12"/><path d="M4 13V9"/><path d="M7.5 13V6"/><path d="M11 13v-7"/></svg>`;
}
function iconCog() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"/></svg>`;
}

// ============================================================================
// HEAD / CSS
// ============================================================================

function renderHead(title) {
  return `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #f7f7f8;
      --surface: #ffffff;
      --surface-soft: #fafafa;
      --line: #e5e5e5;
      --line-strong: #d4d4d4;
      --ink: #0a0a0a;
      --ink-soft: #1f1f1f;
      --muted: #525252;
      --primary-hover: #27272a;
      --success: #15803d;
      --success-soft: #f0fdf4;
      --danger: #b91c1c;
      --danger-soft: #fef2f2;
      --warning: #a16207;
      --warning-soft: #fefce8;
      --info: #1d4ed8;
      --info-soft: #eff6ff;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    h1, h2, h3, h4, p { margin: 0; }
    a { color: inherit; }

    /* SHELL */
    .shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    .sidebar { background: var(--surface); border-right: 1px solid var(--line); padding: 18px 14px; display: flex; flex-direction: column; gap: 8px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 18px; }
    .brand-mark { width: 28px; height: 28px; border-radius: 6px; background: var(--ink); color: white; display: grid; place-items: center; font-weight: 700; font-size: 12px; letter-spacing: -0.02em; }
    .brand-name { font-weight: 600; font-size: 14px; letter-spacing: -0.01em; line-height: 1.1; }
    .brand-name small { display: block; color: var(--muted); font-weight: 400; font-size: 12px; margin-top: 2px; }
    .nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; color: var(--ink-soft); text-decoration: none; font-weight: 500; font-size: 13.5px; }
    .nav a:hover { background: var(--surface-soft); }
    .nav a.active { background: #efefef; color: var(--ink); }
    .nav-icon { display: inline-flex; opacity: 0.65; }
    .nav a.active .nav-icon { opacity: 1; }
    .nav-label { flex: 1; }
    .nav-badge { background: var(--ink); color: white; font-size: 11px; padding: 1px 7px; border-radius: 999px; font-weight: 600; min-width: 20px; text-align: center; }
    .sidebar-footer { border-top: 1px solid var(--line); padding-top: 12px; display: grid; gap: 8px; }
    .sidebar-footer form button { width: 100%; }
    .mode-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 600; align-self: flex-start; }
    .mode-chip.dry { background: var(--info-soft); color: var(--info); }
    .mode-chip.live { background: var(--success-soft); color: var(--success); }
    .mode-chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

    /* MAIN */
    .main { padding: 0; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 28px; border-bottom: 1px solid var(--line); background: var(--surface); position: sticky; top: 0; z-index: 10; min-height: 56px; }
    .breadcrumb { display: flex; align-items: baseline; gap: 8px; }
    .breadcrumb h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .crumb-sub { color: var(--muted); font-size: 13px; }
    .topbar-actions { display: flex; align-items: center; gap: 8px; }
    .page { padding: 28px; max-width: 1240px; }
    .page-head { margin-bottom: 24px; }
    .page-head .eyebrow { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
    .page-head h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
    .page-head p { color: var(--muted); font-size: 14px; margin-top: 8px; max-width: 720px; line-height: 1.55; }

    /* CARDS */
    .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
    .card.compact { padding: 14px; }
    .card-head { margin-bottom: 14px; }
    .card-head .eyebrow { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
    .card-head h2 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
    .card-head h3 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .card-head p { color: var(--muted); font-size: 13px; margin-top: 4px; line-height: 1.45; }
    .card-grid { display: grid; gap: 10px; }
    .card-grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .card-grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .card-grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }

    /* TYPOGRAPHY HELPERS */
    .eyebrow { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .field-label { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; display: block; }
    .subtle { color: var(--muted); }

    /* BUTTONS */
    button, .btn { font: inherit; border: 1px solid var(--ink); background: var(--ink); color: white; height: 34px; padding: 0 14px; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-decoration: none; }
    button:hover, .btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    button.compact, .btn.compact { height: 30px; font-size: 12.5px; padding: 0 11px; }
    button.secondary, .btn.secondary { background: var(--surface); color: var(--ink); border-color: var(--line-strong); }
    button.secondary:hover { background: var(--surface-soft); border-color: var(--line-strong); }
    button.ghost { background: transparent; color: var(--muted); border-color: transparent; }
    button.ghost:hover { background: var(--surface-soft); color: var(--ink); }
    button.approve { background: var(--success); border-color: var(--success); color: white; }
    button.approve:hover { background: #166534; border-color: #166534; }
    button.publish { background: var(--info); border-color: var(--info); color: white; }
    button.publish:hover { background: #1e40af; border-color: #1e40af; }
    button.reject { background: var(--surface); color: var(--danger); border-color: #fecaca; }
    button.reject:hover { background: var(--danger-soft); border-color: #fca5a5; }
    button.delete { background: var(--surface); color: var(--danger); border-color: #fecaca; }
    button.delete:hover { background: var(--danger-soft); border-color: #fca5a5; }
    button.draft { background: var(--surface); color: var(--ink); border-color: var(--line-strong); }
    button.draft:hover { background: var(--surface-soft); }
    button.convert-to-post { background: var(--surface); color: var(--warning); border-color: #fde68a; }
    button.manual-posted { background: var(--info); border-color: var(--info); color: white; }
    button.manual-posted:hover { background: #1e40af; border-color: #1e40af; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* FORMS */
    input, select, textarea { font: inherit; width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); font-size: 13.5px; }
    input:focus, select:focus, textarea:focus { outline: 2px solid #c7d2fe; border-color: #818cf8; }
    textarea { min-height: 96px; resize: vertical; line-height: 1.5; }
    .row { display: grid; gap: 8px; }
    .row.cols-2 { grid-template-columns: repeat(2, 1fr); }

    /* PILLS / BADGES */
    .pill { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; background: var(--surface-soft); color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
    .pill.draft { background: #fafafa; color: var(--muted); }
    .pill.approved { background: var(--success-soft); color: var(--success); border-color: #bbf7d0; }
    .pill.published { background: var(--info-soft); color: var(--info); border-color: #bfdbfe; }
    .pill.rejected { background: var(--danger-soft); color: var(--danger); border-color: #fecaca; }
    .pill.failed { background: var(--warning-soft); color: var(--warning); border-color: #fde68a; }
    .pill.type { background: #fafafa; color: var(--muted); }

    /* TABS */
    .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 20px; overflow-x: auto; flex-wrap: wrap; }
    .tabs a { padding: 10px 14px; color: var(--muted); text-decoration: none; font-weight: 500; font-size: 13.5px; border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .tabs a:hover { color: var(--ink); }
    .tabs a.active { color: var(--ink); border-color: var(--ink); }
    .tabs .count { background: var(--surface-soft); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; min-width: 18px; height: 18px; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }

    /* METRICS */
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .metric { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .metric .label { color: var(--muted); font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .metric .value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; margin-top: 6px; }
    .metric .delta { font-size: 12px; color: var(--muted); margin-top: 4px; }

    /* ITEM */
    .item { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 12px; position: relative; }
    .item.approved { border-left: 3px solid var(--success); }
    .item.published { border-left: 3px solid var(--info); }
    .item.failed { border-left: 3px solid var(--warning); }
    .item.rejected { border-left: 3px solid var(--danger); opacity: 0.85; }
    .item-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 8px; flex-wrap: wrap; }
    .item-head .meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .item-title { font-weight: 600; font-size: 14px; }
    .action-hint { color: var(--muted); font-size: 13px; margin: 6px 0 12px; }
    .chars { color: var(--muted); font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }

    /* CONTEXT */
    .context { background: var(--surface-soft); border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin: 10px 0; }
    .context.missing { background: var(--danger-soft); border-color: #fecaca; }
    .context p { font-size: 13px; line-height: 1.5; }
    .context p span { display: block; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
    .context blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--line-strong); color: var(--ink-soft); font-size: 13px; }
    .context-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
    @media (max-width: 700px) { .context-grid { grid-template-columns: 1fr; } }

    /* ALERTS */
    .alert { padding: 9px 12px; border-radius: 6px; font-size: 13px; margin: 8px 0; }
    .alert.error { background: var(--danger-soft); color: var(--danger); border: 1px solid #fecaca; }
    .alert.success { background: var(--success-soft); color: var(--success); border: 1px solid #bbf7d0; }
    .alert.warning { background: var(--warning-soft); color: var(--warning); border: 1px solid #fde68a; }
    .alert.info { background: var(--info-soft); color: var(--info); border: 1px solid #bfdbfe; }

    /* DETAILS */
    details.advanced, details.composer { background: var(--surface-soft); border: 1px solid var(--line); border-radius: 6px; }
    details.advanced summary, details.composer summary { padding: 8px 12px; cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 500; list-style: none; }
    details.advanced summary::-webkit-details-marker, details.composer summary::-webkit-details-marker { display: none; }
    details.advanced summary::before, details.composer summary::before { content: "+ "; color: var(--muted); font-weight: 600; }
    details.advanced[open] summary::before, details.composer[open] summary::before { content: "− "; }
    .advanced-body, .composer-body { padding: 12px; display: grid; gap: 10px; border-top: 1px solid var(--line); }

    /* EMPTY STATE */
    .empty { text-align: center; padding: 40px 20px; border: 1px dashed var(--line-strong); border-radius: 8px; color: var(--muted); background: var(--surface); font-size: 13.5px; }

    /* COUNCIL */
    .council-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .council-card h3 { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
    .council-card .field { margin: 0 0 10px; font-size: 13.5px; line-height: 1.5; color: var(--ink-soft); }
    .council-card .field span { display: block; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
    .council-card .field a { color: var(--info); }
    .council-card .list { margin: 12px 0; }
    .council-card .list span { display: block; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
    .council-card ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
    .council-card li { font-size: 13.5px; line-height: 1.5; color: var(--ink-soft); }
    .council-card li small { display: block; color: var(--muted); margin-top: 1px; font-size: 12px; }
    .council-card .subcard { background: var(--surface-soft); border-radius: 6px; padding: 10px; margin-top: 8px; border: 1px solid var(--line); }
    .council-card .subcard strong { display: block; font-size: 13px; margin-bottom: 6px; }
    .council-experiment { border-left: 3px solid var(--info); }

    /* HOJE */
    .hoje-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; }
    .hoje-priority { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 28px; }
    .hoje-priority .label { font-size: 11px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 10px; }
    .hoje-priority h2 { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 14px; }
    .hoje-priority p { font-size: 14px; color: var(--ink-soft); line-height: 1.55; }
    .hoje-side { display: grid; gap: 12px; }
    .queue-summary { display: grid; gap: 6px; }
    .queue-summary a { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); text-decoration: none; font-size: 13.5px; }
    .queue-summary a:hover { border-color: var(--line-strong); background: var(--surface-soft); }
    .queue-summary .count { background: var(--ink); color: white; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }

    /* LOGIN */
    .login { min-height: 100vh; display: grid; place-items: center; background: var(--bg); }
    .login-panel { width: min(420px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 28px; }
    .login-panel form { display: grid; gap: 12px; margin-top: 14px; }
    .login-panel button { width: 100%; }

    /* RESPONSIVE */
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .sidebar { position: static; height: auto; flex-direction: column; padding: 12px; }
      .topbar { padding: 12px 16px; }
      .page { padding: 16px; }
      .metric-grid { grid-template-columns: repeat(2, 1fr); }
      .council-grid { grid-template-columns: 1fr; }
      .hoje-grid { grid-template-columns: 1fr; }
      .card-grid.cols-2, .card-grid.cols-3, .card-grid.cols-4 { grid-template-columns: 1fr; }
    }
  </style>
</head>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
