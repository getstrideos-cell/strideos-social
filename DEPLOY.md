# Deploy Stride OS Social

This app gives you a cloud-hosted approval queue:

1. The Growth Pack creates post/reply drafts.
2. You open the dashboard from your phone or laptop.
3. You approve, reject, edit, or publish now.
4. The app publishes only approved items to X.

## Required Environment Variables

```bash
ADMIN_PASSWORD=your-dashboard-password
SESSION_SECRET=a-long-random-string
API_TOKEN=a-long-random-string-for-webhooks
X_USER_ACCESS_TOKEN=your-x-oauth2-user-token
DRY_RUN=false
QUEUE_PATH=/var/data/queue.json
PUBLISH_INTERVAL_MINUTES=15
```

Start with `DRY_RUN=true` until you confirm the queue and login work.

## Render

Recommended setup:

1. Create a new Render Web Service from this folder/repo.
2. Use Node 20.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add a persistent disk mounted at `/var/data`.
6. Set `QUEUE_PATH=/var/data/queue.json`.
7. Add the required environment variables.

If you use the included `render.yaml`, Render can create the service and disk from the blueprint.

### Render API Deploy

Create a temporary Render API key, then save it locally:

```bash
printf "rnd_xxx" > .render-api-key
```

Optionally choose the dashboard password yourself:

```bash
printf "your-password" > .render-admin-password
```

Deploy:

```bash
npm run deploy:render
```

The script creates a `starter` web service with a 1 GB persistent disk mounted at `/var/data`, with `DRY_RUN=true`.

## Railway

Recommended setup:

1. Create a new Railway project from this folder/repo.
2. Add a persistent volume.
3. Mount it at `/data`.
4. Set `QUEUE_PATH=/data/queue.json`.
5. Set the required environment variables.
6. Deploy with `npm start`.

## VPS

On a small VPS:

```bash
cd strideos-social
npm install
npm start
```

Use a process manager such as `pm2` or a `systemd` service for always-on hosting. Put the app behind HTTPS using Caddy, Nginx, or your VPS provider's managed proxy.

## Adding Drafts by API

POST `/api/items` with:

```http
Authorization: Bearer YOUR_API_TOKEN
Content-Type: application/json
```

Single item:

```json
{
  "type": "post",
  "text": "Most solo founders do not need more dashboards. They need a weekly ritual that turns numbers into decisions."
}
```

Multiple items:

```json
{
  "items": [
    {
      "type": "post",
      "text": "Know your numbers. Ship your update."
    },
    {
      "type": "reply",
      "replyToPostId": "1234567890123456789",
      "text": "The best build-in-public updates are usually specific, not polished."
    }
  ]
}
```

## Safety

- The app never publishes drafts.
- Only `approved` items are published.
- Replies need a real X post ID.
- Keep reply volume low and human-approved.
- Avoid duplicate replies, links in replies, and anything that looks like bulk outreach.
