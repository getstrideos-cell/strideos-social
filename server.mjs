import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { loadEnv } from "./scripts/load-env.mjs";
import { createQueueItem, readQueue, updateQueue } from "./scripts/queue-store.mjs";
import { publishApproved } from "./scripts/publisher.mjs";

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      return sendText(res, 200, "ok");
    }

    if (url.pathname === "/api/items" && req.method === "POST") {
      return handleApiCreateItem(req, res);
    }

    if (url.pathname === "/login" && req.method === "GET") {
      return sendHtml(res, renderLogin());
    }

    if (url.pathname === "/login" && req.method === "POST") {
      return handleLogin(req, res);
    }

    if (!isAuthenticated(req)) {
      return redirect(res, "/login");
    }

    if (url.pathname === "/logout" && req.method === "POST") {
      return handleLogout(res);
    }

    if (url.pathname === "/" && req.method === "GET") {
      const queue = await readQueue();
      return sendHtml(res, renderDashboard(queue, { dryRun, publishIntervalMinutes }));
    }

    if (url.pathname === "/items" && req.method === "POST") {
      return handleCreateItem(req, res);
    }

    const itemAction = url.pathname.match(/^\/items\/([^/]+)\/(approve|reject|draft|update|publish)$/);
    if (itemAction && req.method === "POST") {
      const [, id, action] = itemAction;
      return handleItemAction(req, res, id, action);
    }

    if (url.pathname === "/publish" && req.method === "POST") {
      return handlePublishNow(res);
    }

    return sendText(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    return sendText(res, 500, error instanceof Error ? error.message : "Server error");
  }
});

server.listen(port, () => {
  console.log(`Stride OS publisher running on http://localhost:${port}`);
});

async function handleApiCreateItem(req, res) {
  if (!apiToken || req.headers.authorization !== `Bearer ${apiToken}`) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const body = await parseBody(req);
  const created = await updateQueue((queue) => {
    const items = Array.isArray(body.items) ? body.items : [body];
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
        replyToPostId: body.replyToPostId,
        text: body.text,
        source: "dashboard"
      })
    );
  });
  return redirect(res, "/");
}

async function handleItemAction(req, res, id, action) {
  if (action === "publish") {
    await updateQueue((queue) => {
      const item = findItem(queue, id);
      if (item.status !== "published") {
        item.status = "approved";
        item.updatedAt = new Date().toISOString();
      }
    });
    await publishApproved({ accessToken, dryRun, onlyId: id });
    return redirect(res, "/");
  }

  const body = action === "update" ? await parseBody(req) : {};
  await updateQueue((queue) => {
    const item = findItem(queue, id);

    if (action === "update") {
      item.type = body.type || item.type;
      item.replyToPostId = body.replyToPostId || undefined;
      item.text = body.text || "";
    } else {
      item.status = action === "reject" ? "rejected" : action;
    }

    item.updatedAt = new Date().toISOString();
  });

  return redirect(res, "/");
}

async function handlePublishNow(res) {
  await publishApproved({ accessToken, dryRun });
  return redirect(res, "/");
}

function findItem(queue, id) {
  const item = queue.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`No item found with id: ${id}`);
  return item;
}

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

function renderLogin(error) {
  return `<!doctype html>
<html lang="en">
${renderHead("Login")}
<body class="login">
  <main class="login-panel">
    <p class="eyebrow">Stride OS</p>
    <h1>Approval Queue</h1>
    <form method="post" action="/login">
      <label>Password</label>
      <input name="password" type="password" autocomplete="current-password" required autofocus>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <button type="submit">Enter</button>
    </form>
  </main>
</body>
</html>`;
}

function renderDashboard(queue, options) {
  const counts = queue.items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  const items = queue.items
    .map((item) => renderItem(item))
    .join("");

  return `<!doctype html>
<html lang="en">
${renderHead("Stride OS Publisher")}
<body>
  <header class="topbar">
    <div>
      <p class="eyebrow">Stride OS</p>
      <h1>Publishing Queue</h1>
    </div>
    <form method="post" action="/logout">
      <button class="secondary" type="submit">Logout</button>
    </form>
  </header>

  <main>
    <section class="status-strip">
      ${renderMetric("Draft", counts.draft || 0)}
      ${renderMetric("Approved", counts.approved || 0)}
      ${renderMetric("Published", counts.published || 0)}
      ${renderMetric("Failed", counts.failed || 0)}
      ${renderMetric("Mode", options.dryRun ? "Dry run" : "Live")}
    </section>

    <section class="toolbar">
      <form method="post" action="/publish">
        <button type="submit">Publish approved now</button>
      </form>
      <p>${options.publishIntervalMinutes > 0 ? `Auto publisher checks every ${options.publishIntervalMinutes} min.` : "Auto publisher interval is off."}</p>
    </section>

    <section class="composer">
      <h2>Add draft</h2>
      <form method="post" action="/items">
        <div class="row">
          <select name="type">
            <option value="post">Post</option>
            <option value="reply">Reply</option>
          </select>
          <input name="replyToPostId" placeholder="Reply post ID, only for replies">
        </div>
        <textarea name="text" maxlength="280" placeholder="Write or paste an English X post/reply..." required></textarea>
        <button type="submit">Add to queue</button>
      </form>
    </section>

    <section class="items">
      ${items || `<p class="empty">No queued items yet.</p>`}
    </section>
  </main>
</body>
</html>`;
}

function renderMetric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function renderItem(item) {
  const charCount = item.text?.length || 0;
  return `<article class="item ${escapeHtml(item.status)}">
    <div class="item-head">
      <div>
        <span class="pill">${escapeHtml(item.status)}</span>
        <span class="muted">${escapeHtml(item.type)} · ${escapeHtml(item.id)}</span>
      </div>
      <span class="chars">${charCount}/280</span>
    </div>

    ${item.error ? `<p class="error">${escapeHtml(item.error)}</p>` : ""}
    ${item.xPostId ? `<p class="success">Published X post ID: ${escapeHtml(item.xPostId)}</p>` : ""}

    <form method="post" action="/items/${encodeURIComponent(item.id)}/update">
      <div class="row">
        <select name="type">
          <option value="post" ${item.type === "post" ? "selected" : ""}>Post</option>
          <option value="reply" ${item.type === "reply" ? "selected" : ""}>Reply</option>
        </select>
        <input name="replyToPostId" value="${escapeHtml(item.replyToPostId || "")}" placeholder="Reply post ID">
      </div>
      <textarea name="text" maxlength="280">${escapeHtml(item.text || "")}</textarea>
      <div class="actions">
        <button class="secondary" type="submit">Save</button>
        ${renderAction(item, "approve", "Approve")}
        ${renderAction(item, "publish", "Publish now")}
        ${renderAction(item, "reject", "Reject")}
        ${renderAction(item, "draft", "Back to draft")}
      </div>
    </form>
  </article>`;
}

function renderAction(item, action, label) {
  if (item.status === "published" && action !== "draft") return "";
  return `<button formmethod="post" formaction="/items/${encodeURIComponent(item.id)}/${action}" class="${action}" type="submit">${label}</button>`;
}

function renderHead(title) {
  return `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f7f5ef; color: #1d2625; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f5ef; }
    main, .topbar { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 28px 0 18px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; line-height: 1.1; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    .eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: 0; color: #68716f; font-weight: 700; margin-bottom: 6px; }
    button, input, select, textarea { font: inherit; }
    button { border: 0; border-radius: 6px; background: #1d2625; color: #fff; min-height: 40px; padding: 0 14px; cursor: pointer; font-weight: 700; }
    button.secondary { background: #e3dfd4; color: #1d2625; }
    button.approve { background: #136f63; }
    button.publish { background: #2f5f9f; }
    button.reject { background: #a33a31; }
    button.draft { background: #7a6a53; }
    input, select, textarea { width: 100%; border: 1px solid #d7d2c4; border-radius: 6px; background: #fffdfa; color: #1d2625; padding: 10px 12px; }
    textarea { min-height: 112px; resize: vertical; line-height: 1.4; }
    .login { min-height: 100vh; display: grid; place-items: center; }
    .login-panel { width: min(420px, calc(100vw - 32px)); background: #fffdfa; border: 1px solid #ddd7ca; border-radius: 8px; padding: 24px; }
    .login-panel form { display: grid; gap: 10px; margin-top: 20px; }
    .status-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin: 10px 0 16px; }
    .metric { background: #fffdfa; border: 1px solid #ddd7ca; border-radius: 8px; padding: 14px; }
    .metric span { display: block; color: #68716f; font-size: 12px; margin-bottom: 6px; }
    .metric strong { font-size: 20px; }
    .toolbar, .composer, .item { background: #fffdfa; border: 1px solid #ddd7ca; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #68716f; }
    .composer form, .item form { display: grid; gap: 10px; }
    .row { display: grid; grid-template-columns: 160px 1fr; gap: 10px; }
    .item-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 10px; }
    .pill { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; background: #e3dfd4; color: #1d2625; padding: 0 10px; font-size: 12px; font-weight: 800; margin-right: 8px; }
    .muted, .chars { color: #68716f; font-size: 13px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .error { color: #a33a31; font-size: 14px; }
    .success { color: #136f63; font-size: 14px; }
    .empty { color: #68716f; padding: 28px 0; text-align: center; }
    @media (max-width: 760px) {
      .topbar, .toolbar { align-items: stretch; flex-direction: column; }
      .status-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .row { grid-template-columns: 1fr; }
      button { width: 100%; }
      .actions { display: grid; grid-template-columns: 1fr; }
    }
  </style>
</head>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
