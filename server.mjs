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

    const itemAction = url.pathname.match(/^\/items\/([^/]+)\/(approve|reject|draft|update|publish|delete)$/);
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
        replyToPostId: body.replyToPostId,
        targetAuthor: body.targetAuthor,
        targetHandle: body.targetHandle,
        targetPostUrl: body.targetPostUrl,
        targetPostText: body.targetPostText,
        targetPostSummary: body.targetPostSummary,
        replyRationale: body.replyRationale,
        text: body.text,
        source: "dashboard"
      })
    );
  });
  return redirect(res, "/");
}

async function handleItemAction(req, res, id, action) {
  if (action === "delete") {
    await updateQueue((queue) => {
      const index = queue.items.findIndex((candidate) => candidate.id === id);
      if (index === -1) throw new Error(`No item found with id: ${id}`);
      queue.items.splice(index, 1);
    });
    return redirect(res, "/");
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
    return redirect(res, "/");
  }

  const body = action === "update" ? await parseBody(req) : {};
  await updateQueue((queue) => {
    const item = findItem(queue, id);

    if (action === "update") {
      item.type = body.type || item.type;
      item.replyToPostId = body.replyToPostId || undefined;
      item.targetAuthor = body.targetAuthor || undefined;
      item.targetHandle = body.targetHandle || undefined;
      item.targetPostUrl = body.targetPostUrl || undefined;
      item.targetPostText = body.targetPostText || undefined;
      item.targetPostSummary = body.targetPostSummary || undefined;
      item.replyRationale = body.replyRationale || undefined;
      item.text = body.text || "";
    } else {
      item.status = action === "approve" ? "approved" : action === "reject" ? "rejected" : action;
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

  const needsReview = queue.items.filter((item) => ["draft", "failed"].includes(item.status));
  const approved = queue.items.filter((item) => item.status === "approved");
  const archive = queue.items.filter((item) => ["published", "rejected"].includes(item.status));

  return `<!doctype html>
<html lang="en">
${renderHead("Stride OS Publisher")}
<body>
  <header class="topbar">
    <div class="brand-row">
      <div class="brand-mark">SO</div>
      <div>
        <p class="eyebrow">Stride OS Social</p>
        <h1>Review Queue</h1>
        <p class="subtitle">Approve posts and contextual replies before they reach X.</p>
      </div>
    </div>
    <div class="top-actions">
      <span class="mode-chip ${options.dryRun ? "dry" : "live"}">${options.dryRun ? "Dry run" : "Live"}</span>
      <form method="post" action="/logout">
        <button class="secondary compact" type="submit">Logout</button>
      </form>
    </div>
  </header>

  <main>
    <section class="status-strip">
      ${renderMetric("Draft", counts.draft || 0)}
      ${renderMetric("Approved", counts.approved || 0)}
      ${renderMetric("Published", counts.published || 0)}
      ${renderMetric("Failed", counts.failed || 0)}
      ${renderMetric("Mode", options.dryRun ? "Dry run" : "Live")}
    </section>

    <section class="mode-banner ${options.dryRun ? "dry" : "live"}">
      <div>
        <strong>${options.dryRun ? "Dry run mode" : "Live publishing is on"}</strong>
        <p>${options.dryRun ? "You can test approvals and publish buttons safely. Nothing will post to X." : "Approved items can publish to X. Review the text and target before you publish."}</p>
      </div>
      <form method="post" action="/publish">
        <button type="submit">${options.dryRun ? "Test approved items" : "Publish approved now"}</button>
      </form>
    </section>

    <details class="composer">
      <summary>Add a draft manually</summary>
      <div class="composer-body">
        <form method="post" action="/items">
          <div class="row">
            <select name="type">
              <option value="post">Post</option>
              <option value="reply">Reply</option>
            </select>
            <input name="replyToPostId" placeholder="Reply post ID, only for replies">
          </div>
          <textarea name="text" maxlength="280" placeholder="Write or paste an English X post/reply..." required></textarea>
          <details class="advanced">
            <summary>Reply context</summary>
            <div class="advanced-body">
              <div class="row">
                <input name="targetAuthor" placeholder="Target author">
                <input name="targetHandle" placeholder="@handle">
              </div>
              <input name="targetPostUrl" placeholder="Target post URL">
              <textarea name="targetPostSummary" placeholder="Short summary of the post being replied to"></textarea>
              <textarea name="targetPostText" placeholder="Original post text/context"></textarea>
              <textarea name="replyRationale" placeholder="Why this reply is worth posting"></textarea>
            </div>
          </details>
          <button type="submit">Add draft</button>
        </form>
      </div>
    </details>

    ${renderItemSection("Needs Review", "Edit, approve, or reject these before anything can publish.", needsReview, "review")}
    ${renderItemSection("Approved", "Ready to publish. In live mode, the publish button posts to X.", approved, "approved")}
    ${renderItemSection("Archive", "Published, rejected, and deleted candidates stay out of the review flow.", archive, "archive", true)}
  </main>
</body>
</html>`;
}

function renderMetric(label, value) {
  const key = label.toLowerCase().replaceAll(" ", "-");
  return `<div class="metric ${escapeHtml(key)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function renderItem(item) {
  const charCount = item.text?.length || 0;
  const title = item.type === "reply" ? "Suggested reply" : "Suggested post";
  const actionHint = getActionHint(item);
  return `<article class="item ${escapeHtml(item.status)}">
    <div class="item-head">
      <div>
        <span class="pill">${escapeHtml(item.status)}</span>
        <span class="type-pill">${escapeHtml(item.type)}</span>
        <span class="item-title">${title}</span>
      </div>
      <span class="chars">${charCount}/280</span>
    </div>
    <p class="action-hint">${escapeHtml(actionHint)}</p>

    ${item.error ? `<p class="alert error">${escapeHtml(item.error)}</p>` : ""}
    ${item.xPostId ? `<p class="alert success">Published X post ID: ${escapeHtml(item.xPostId)}</p>` : ""}
    ${renderTargetContext(item)}

    <form method="post" action="/items/${encodeURIComponent(item.id)}/update">
      <label class="field-label">Public text</label>
      <textarea name="text" maxlength="280" ${item.status === "published" ? "readonly" : ""}>${escapeHtml(item.text || "")}</textarea>
      ${renderAdvancedFields(item)}
      <div class="actions">
        ${renderActions(item)}
      </div>
    </form>
  </article>`;
}

function renderItemSection(title, description, items, kind, collapsed = false) {
  const head = `<div class="section-head">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <strong>${items.length}</strong>
    </div>`;
  const body = `<div class="items">
      ${items.map((item) => renderItem(item)).join("") || `<p class="empty">Nothing here.</p>`}
    </div>`;

  if (collapsed) {
    return `<details class="queue-section collapsible ${escapeHtml(kind)}">
      <summary>${head}</summary>
      ${body}
    </details>`;
  }

  return `<section class="queue-section ${escapeHtml(kind)}">
    ${head}
    ${body}
  </section>`;
}

function getActionHint(item) {
  if (item.status === "approved") return "Ready. Publish now, send back to draft, or reject.";
  if (item.status === "failed") return "Publishing failed. Review the error, edit if needed, then approve again.";
  if (item.status === "rejected") return "Rejected. Restore to draft or delete it from the queue.";
  if (item.status === "published") return "Published to X.";
  if (item.type === "reply") return "Review the target post and suggested reply before approving.";
  return "Review the post text, then approve or reject.";
}

function renderAdvancedFields(item) {
  return `<details class="advanced">
    <summary>${item.type === "reply" ? "Edit reply target" : "Advanced settings"}</summary>
    <div class="advanced-body">
      <div class="row">
        <select name="type">
          <option value="post" ${item.type === "post" ? "selected" : ""}>Post</option>
          <option value="reply" ${item.type === "reply" ? "selected" : ""}>Reply</option>
        </select>
        <input name="replyToPostId" value="${escapeHtml(item.replyToPostId || "")}" placeholder="Reply post ID">
      </div>
      <div class="row">
        <input name="targetAuthor" value="${escapeHtml(item.targetAuthor || "")}" placeholder="Target author">
        <input name="targetHandle" value="${escapeHtml(item.targetHandle || "")}" placeholder="@handle">
      </div>
      <input name="targetPostUrl" value="${escapeHtml(item.targetPostUrl || "")}" placeholder="Target post URL">
      <textarea name="targetPostSummary" placeholder="Short summary of the post being replied to">${escapeHtml(item.targetPostSummary || "")}</textarea>
      <textarea name="targetPostText" placeholder="Original post text/context">${escapeHtml(item.targetPostText || "")}</textarea>
      <textarea name="replyRationale" placeholder="Why this reply is worth posting">${escapeHtml(item.replyRationale || "")}</textarea>
    </div>
  </details>`;
}

function renderTargetContext(item) {
  if (item.type !== "reply") return "";

  const author = [item.targetAuthor, item.targetHandle].filter(Boolean).join(" ");
  const hasContext = item.targetPostUrl && item.targetPostSummary && item.replyRationale && (item.targetAuthor || item.targetHandle);

  return `<section class="target-context ${hasContext ? "" : "missing"}">
    <div class="target-head">
      <strong>${hasContext ? "Reply target" : "Reply target missing"}</strong>
      ${item.targetPostUrl ? `<a href="${escapeHtml(item.targetPostUrl)}" target="_blank" rel="noreferrer">Open post</a>` : ""}
    </div>
    ${hasContext ? "" : `<p><span>Needs context</span>Add the original post, author, summary, and reason before approving this reply.</p>`}
    ${author ? `<p><span>Author</span>${escapeHtml(author)}</p>` : ""}
    ${item.targetPostSummary ? `<p><span>Summary</span>${escapeHtml(item.targetPostSummary)}</p>` : ""}
    ${item.targetPostText ? `<blockquote>${escapeHtml(item.targetPostText)}</blockquote>` : ""}
    ${item.replyRationale ? `<p><span>Why reply</span>${escapeHtml(item.replyRationale)}</p>` : ""}
  </section>`;
}

function renderActions(item) {
  if (item.status === "published") return "";

  const save = `<button class="secondary" type="submit">Save edits</button>`;
  const approve = renderAction(item, "approve", "Approve");
  const publish = renderAction(item, "publish", "Publish now");
  const reject = renderAction(item, "reject", "Reject");
  const draft = renderAction(item, "draft", "Back to draft");
  const remove = renderAction(item, "delete", "Delete");

  if (item.status === "approved") return `${save}${publish}${draft}${reject}`;
  if (item.status === "rejected") return `${draft}${remove}`;
  if (item.status === "failed") return `${save}${approve}${reject}${remove}`;
  return `${save}${approve}${reject}`;
}

function renderAction(item, action, label) {
  return `<button formmethod="post" formaction="/items/${encodeURIComponent(item.id)}/${action}" class="${action}" type="submit">${label}</button>`;
}

function renderHead(title) {
  return `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f1ea;
      color: #18211f;
      --surface: #fffdfa;
      --surface-soft: #f8f5ed;
      --line: #d9d2c2;
      --muted: #64706d;
      --ink: #18211f;
      --green: #12685c;
      --blue: #2e5c9a;
      --red: #a63d35;
      --amber: #8a6424;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at top left, #eef7f4 0, transparent 280px), #f4f1ea; }
    main, .topbar { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; }
    main { padding-bottom: 40px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 28px 0 20px; }
    .brand-row { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-mark { width: 44px; height: 44px; border-radius: 8px; display: grid; place-items: center; background: #18211f; color: #fffdfa; font-weight: 900; font-size: 14px; }
    .top-actions { display: flex; align-items: center; gap: 10px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 30px; line-height: 1.05; letter-spacing: 0; }
    h2 { font-size: 18px; letter-spacing: 0; }
    .subtitle { color: var(--muted); margin-top: 5px; font-size: 15px; line-height: 1.35; }
    .eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: 0; color: var(--muted); font-weight: 800; margin-bottom: 6px; }
    button, input, select, textarea { font: inherit; }
    button { border: 0; border-radius: 7px; background: var(--ink); color: #fff; min-height: 40px; padding: 0 14px; cursor: pointer; font-weight: 800; box-shadow: 0 1px 0 rgba(0,0,0,.06); }
    button.compact { min-height: 36px; }
    button.secondary { background: #e4dfd3; color: var(--ink); }
    button.approve { background: var(--green); }
    button.publish { background: var(--blue); }
    button.reject { background: var(--red); }
    button.draft { background: #73624b; }
    button.delete { background: #4f4540; }
    input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: #fffefa; color: var(--ink); padding: 10px 12px; }
    textarea { min-height: 118px; resize: vertical; line-height: 1.45; }
    textarea:focus, input:focus, select:focus { outline: 2px solid rgba(46, 92, 154, .22); border-color: #8aa6cd; }
    .login { min-height: 100vh; display: grid; place-items: center; }
    .login-panel { width: min(420px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 24px; box-shadow: 0 24px 80px rgba(31, 36, 34, .12); }
    .login-panel form { display: grid; gap: 10px; margin-top: 20px; }
    .status-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin: 8px 0 14px; }
    .metric { background: rgba(255, 253, 250, .82); border: 1px solid var(--line); border-radius: 8px; padding: 13px 14px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; font-weight: 700; }
    .metric strong { font-size: 21px; letter-spacing: 0; }
    .metric.approved strong { color: var(--green); }
    .metric.failed strong { color: var(--red); }
    .metric.published strong { color: var(--blue); }
    .mode-chip { display: inline-flex; align-items: center; min-height: 30px; padding: 0 10px; border-radius: 999px; font-weight: 900; font-size: 13px; }
    .mode-chip.dry { background: #e7f1f5; color: #24556c; }
    .mode-chip.live { background: #fae3df; color: #8b2d25; }
    .mode-banner, .composer, .item { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 14px; box-shadow: 0 1px 0 rgba(0,0,0,.02); }
    .mode-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-left: 4px solid var(--blue); }
    .mode-banner strong { display: block; font-size: 15px; margin-bottom: 3px; }
    .mode-banner p { color: var(--muted); font-size: 14px; line-height: 1.4; }
    .mode-banner.dry { border-color: #c6d7de; background: #f5fbfd; }
    .mode-banner.live { border-color: #e1b8b2; background: #fff7f5; }
    .composer { padding: 0; overflow: hidden; }
    .composer summary { cursor: pointer; padding: 14px 16px; font-weight: 800; }
    .composer-body { border-top: 1px solid var(--line); padding: 16px; }
    .composer form, .item form { display: grid; gap: 10px; }
    .queue-section { margin: 26px 0; }
    .queue-section.collapsible { border: 0; }
    .queue-section.collapsible > summary { cursor: pointer; list-style: none; }
    .queue-section.collapsible > summary::-webkit-details-marker { display: none; }
    .section-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 10px; }
    .section-head p { color: var(--muted); font-size: 14px; line-height: 1.4; margin-top: 4px; }
    .section-head strong { min-width: 34px; height: 34px; border-radius: 999px; display: grid; place-items: center; background: #e5dfd2; font-size: 14px; }
    .row { display: grid; grid-template-columns: 160px 1fr; gap: 10px; }
    .item { position: relative; overflow: hidden; }
    .item::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: #d4cbbb; }
    .item.approved::before { background: var(--green); }
    .item.failed::before { background: var(--red); }
    .item.published::before { background: var(--blue); }
    .item-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 6px; }
    .pill, .type-pill { display: inline-flex; align-items: center; min-height: 24px; border-radius: 999px; padding: 0 9px; font-size: 12px; font-weight: 900; margin-right: 7px; }
    .pill { background: #e4dfd3; color: var(--ink); }
    .item.approved .pill { background: #dcefe8; color: #0f5d52; }
    .item.failed .pill { background: #f4dedb; color: #8d3029; }
    .item.published .pill { background: #dfe9f6; color: #28558e; }
    .type-pill { background: #edf0ee; color: #53615d; }
    .item-title { font-weight: 900; margin-right: 8px; }
    .muted, .chars { color: var(--muted); font-size: 13px; }
    .action-hint { color: var(--muted); font-size: 13px; line-height: 1.4; margin-bottom: 12px; }
    .field-label { color: var(--muted); font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0; }
    .target-context { border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); padding: 13px; margin: 10px 0 12px; display: grid; gap: 9px; }
    .target-context.missing { border-color: #e1b8b2; background: #fff7f5; }
    .target-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .target-head strong { font-size: 14px; }
    .target-head a { color: var(--blue); font-size: 13px; font-weight: 800; text-decoration: none; }
    .target-context p { font-size: 14px; line-height: 1.4; }
    .target-context span { display: block; color: var(--muted); font-size: 12px; font-weight: 900; margin-bottom: 2px; }
    .target-context blockquote { margin: 0; border-left: 3px solid #c8bea9; padding-left: 10px; color: #3d4644; font-size: 14px; line-height: 1.45; }
    .advanced { border: 1px solid #e4dfd2; border-radius: 8px; background: #fffefa; }
    .advanced summary { cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 900; padding: 10px 12px; }
    .advanced-body { border-top: 1px solid #e4dfd2; display: grid; gap: 10px; padding: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .alert { border-radius: 8px; padding: 10px 12px; font-size: 14px; line-height: 1.4; }
    .error { color: #8d3029; background: #fff2ef; border: 1px solid #efc9c3; }
    .success { color: #0f5d52; background: #eff8f4; border: 1px solid #cce7dd; }
    .empty { color: var(--muted); padding: 26px 0; text-align: center; border: 1px dashed #d4cbbb; border-radius: 8px; background: rgba(255,253,250,.5); }
    @media (max-width: 760px) {
      .topbar, .mode-banner { align-items: stretch; flex-direction: column; }
      .brand-row { align-items: flex-start; }
      .top-actions { justify-content: space-between; }
      .status-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .row { grid-template-columns: 1fr; }
      .item-head { flex-direction: column; }
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
