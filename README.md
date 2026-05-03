# Stride OS Social Publishing Kit

This is the approval layer for Stride OS posts and replies.

The workflow is intentionally conservative:

1. The daily Growth Pack suggests content.
2. You copy the best items into `content/queue.json`.
3. You set `"status": "approved"` only for items you want published.
4. The publisher posts only approved items.

## Queue Item Types

Regular post:

```json
{
  "id": "post-2026-05-03-001",
  "status": "approved",
  "type": "post",
  "text": "Your X post text here."
}
```

Reply:

```json
{
  "id": "reply-2026-05-03-001",
  "status": "approved",
  "type": "reply",
  "replyToPostId": "1234567890123456789",
  "text": "Your reply text here."
}
```

## Environment

Create a `.env` file based on `.env.example`:

```bash
X_USER_ACCESS_TOKEN=your_oauth2_user_access_token
DRY_RUN=true
ADMIN_PASSWORD=your-dashboard-password
SESSION_SECRET=a-long-random-string
```

Use an OAuth 2.0 user access token with `tweet.write` permission.

## Dashboard

Start the approval dashboard:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

From the dashboard you can add drafts, edit text, approve, reject, and publish approved items.

## Commands

Check queue:

```bash
npm run queue:check
```

Approve an item:

```bash
npm run approve -- example-post-001
```

Reject an item:

```bash
npm run reject -- example-post-001
```

Dry run publish:

```bash
npm run publish:x
```

Real publish:

```bash
DRY_RUN=false npm run publish:x
```

## Safety Rules

- Keep replies manual-approved.
- Avoid posting links in replies.
- Do not publish duplicate or near-duplicate comments.
- Prefer 1 original post and 2-3 high-quality replies per day.
- Do not use automated likes or aggressive engagement behavior.

## Deploy

See `DEPLOY.md` for Render, Railway, and VPS instructions.
