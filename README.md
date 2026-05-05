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
  "targetAuthor": "Founder Name",
  "targetHandle": "@founder",
  "targetPostUrl": "https://x.com/founder/status/1234567890123456789",
  "targetPostSummary": "The founder is discussing weekly SaaS metrics.",
  "replyRationale": "This is aligned with Stride OS because it connects founder consistency with real operating signal.",
  "text": "Your reply text here."
}
```

## Environment

Create a `.env` file based on `.env.example`:

```bash
X_USER_ACCESS_TOKEN=your_oauth2_user_access_token
X_REFRESH_TOKEN=your_oauth2_refresh_token
X_CLIENT_ID=your_oauth2_client_id
X_CLIENT_SECRET=your_oauth2_client_secret
DRY_RUN=true
ADMIN_PASSWORD=your-dashboard-password
SESSION_SECRET=a-long-random-string
```

Use OAuth 2.0 credentials with `tweet.read`, `tweet.write`, `users.read`, and `offline.access`.
When X returns an expired-token `401`, the publisher uses the refresh token to renew the access token and stores the rotated token beside the queue file.

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

## Render Agents

The hosted service can generate drafts by itself without the Codex desktop automation or your notebook.

- Founder board: runs around 08:30 America/Sao_Paulo and creates the daily strategy memo.
- Daily growth pack: runs around 09:00 America/Sao_Paulo and creates 5 text drafts.
- Founder moment: runs around 10:30 America/Sao_Paulo and creates 1 manual image/photo suggestion.
- These agents write directly to the Render queue/state files, so they do not need to call the public dashboard API.
- The dashboard also has manual buttons to run each generator immediately.

Optional controls:

```bash
RENDER_AGENTS_ENABLED=false
FOUNDER_BOARD_HOUR=8
FOUNDER_BOARD_MINUTE=30
GROWTH_PACK_HOUR=9
GROWTH_PACK_MINUTE=0
FOUNDER_MOMENT_HOUR=10
FOUNDER_MOMENT_MINUTE=30
AGENT_TIMEZONE=America/Sao_Paulo
```

## Founder Board Sources

The Founder Board uses every source that is configured, then falls back gracefully when a source is missing.

```bash
TARGET_X_HANDLES=gregisenberg,noahkagan,george__mack,buildinpublic,openai,perplexity_ai,AnthropicAI
REDDIT_SUBREDDITS=SaaS,startups,Entrepreneur,SideProject,indiehackers
REDDIT_SEARCH_QUERIES=solo founder,build in public,SaaS metrics,AI agents startup,distribution
PLAUSIBLE_API_KEY=your_plausible_stats_api_key
PLAUSIBLE_SITE_ID=getstrideos.com
POSTHOG_PERSONAL_API_KEY=your_posthog_personal_api_key
POSTHOG_PROJECT_ID=your_posthog_project_id
POSTHOG_HOST=https://us.posthog.com
```

Connected sources:

- X market radar: reads target accounts for founder, AI, SaaS, distribution, and build-in-public signals.
- X performance: learns from published posts that have an `xPostId` in the queue.
- Reddit/community radar: reads public subreddit search results.
- Plausible or PostHog: reads landing/product analytics when keys are configured.
- Google Analytics: connect through OAuth from the dashboard and read GA4 landing analytics.
- Internal feedback: uses approvals, rejections, failures, published queue history, and manual suggestions.

Google Analytics OAuth:

```bash
GOOGLE_ANALYTICS_PROPERTY_ID=533586451
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
GOOGLE_REDIRECT_URI=https://strideos-social.onrender.com/auth/google/callback
GOOGLE_LOGIN_HINT=getstrideos@gmail.com
```

In Google Cloud, enable the Google Analytics Data API, create an OAuth client for a Web application, and add this authorized redirect URI:

```text
https://strideos-social.onrender.com/auth/google/callback
```

After the Render variables are saved, use the dashboard button `Conectar Google Analytics`.

Optional OpenAI enhancement:

```bash
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5-mini
OPENAI_ENABLED=true
```

When `OPENAI_API_KEY` is configured, the Founder Board uses the OpenAI Responses API with Structured Outputs to improve the market memo, marketing strategy, product strategy, growth experiment, and daily draft recommendations. Without the key, the system keeps using the rule-based fallback.

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

Generate local drafts manually:

```bash
npm run generate:board
npm run generate:growth
npm run generate:moment
```

## Safety Rules

- Keep replies manual-approved.
- Avoid posting links in replies.
- Do not publish duplicate or near-duplicate comments.
- Prefer 1 original post and 2-3 high-quality replies per day.
- Do not use automated likes or aggressive engagement behavior.

## Deploy

See `DEPLOY.md` for Render, Railway, and VPS instructions.
