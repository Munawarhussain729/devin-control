# Devin Control

A zero-dependency (Node 18+) dashboard and control panel for your Devin sessions.
Install it on your phone's home screen or open it on the desktop.

## What you get

**Dashboard** — analytics across *all* your sessions (including archived):
- live pills: working now / needs you / sleeping (tap to jump into the list)
- KPIs per range (7d / 30d / 90d / all): sessions created, finished, PRs & merged PRs,
  ACUs burned, avg ACU/session, on-demand spend (Teams plans)
- charts: sessions started, ACU burn, current status mix, work type (category),
  top projects, session origins (web/slack/api/cli…), Devin modes
- "Needs you now" list of sessions waiting for input
- one-tap JSON export of the full synced dataset

**Projects** — every session grouped under a project:
- automatic groups from the repo in each session's PR urls
- your own rules: match on repo name, tag, or title substring (edit in-app, stored
  in `projects.json`), with custom colors
- per-project view: sessions, ACUs, PRs, spend, 30-day activity chart
- tag a session `project:name` from the session menu, or pick a project when
  starting a session (fills repos + tag for you)

**Sessions** (Cloud tab) — everything the original panel did:
- list with live status, filters (needs me / working / done / archived) and search
- read the conversation, send messages (wakes sleeping sessions)
- sleep & archive, unarchive, terminate, edit tags, copy session id / Devin link
- start sessions: prompt, title, project picker, repos (datalist from your org),
  tags, mode, max ACUs

**Local IDE** — sessions from Devin Desktop/CLI on this Mac (these live on disk and
never appear in the cloud API):
- every local session grouped by its project directory, with message/tool/prompt
  counts and the permission mode used
- full transcript view: your prompts, agent replies, thoughts, plan updates and
  tool calls
- **send prompts**: resume any local session right from the panel — the reply
  streams in live. Requires `devin auth login` to have been run once on the Mac
  (the app drives `devin acp` under the hood and authenticates with the CLI's
  session token). Sessions currently open in a Devin Desktop window are locked
  — close them there first.
- per-session menu to copy the session id, project path, or `devin -r` resume command

Your Devin API key stays on the server. The browser only gets a password-protected,
signed session cookie.

## 1. Get Devin credentials

In Devin: **Settings > Devin API > Service users > Provision service user**.
Pick the **Member** role, copy the `cog_...` key (shown once), and note your
**Organization ID** shown at the top of that page.

## 2. Configure

```bash
cp .env.example .env
# edit .env: DEVIN_API_KEY, DEVIN_ORG_ID, APP_PASSWORD (8+ chars, make it long)
node server.js
```

Open http://localhost:8787 to check it works.

## 3. Reach it from your phone (needs HTTPS)

The app is useless on a phone if it only runs on your laptop, and cookies/installable-app features need HTTPS. Pick one:

**Cloudflare Tunnel (free, quickest if your machine stays on)**
```bash
cloudflared tunnel --url http://localhost:8787
```
Set `TRUST_PROXY=1` in `.env`, restart, open the printed https URL on your phone.

**Small host (always on): Render, Railway, Fly.io, any VPS**
Deploy this folder (a `Dockerfile` is included). Set `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `APP_PASSWORD` as environment variables on the host, and `TRUST_PROXY=1` (the Dockerfile already sets it).
Mount a volume at `/app/data` (or set `DATA_DIR`) so `projects.json` survives redeploys.

## 4. Install on your phone

- **iPhone (Safari):** Share > Add to Home Screen
- **Android (Chrome):** menu > Install app / Add to Home screen

## How it works

- `GET /api/analytics` — the server walks every page of `GET /v3/organizations/{org}/sessions`
  (live + archived, up to 10k sessions each) and returns a compact payload, cached 60s.
  Add `?refresh=1` to bypass the cache. The dashboard/projects views slice it locally.
- `GET|POST /api/projects` — reads/writes `{projects: [{name, match[], color?}]}` in
  `DATA_DIR/projects.json` (default: app directory).
- `GET /api/repos` — org repository list (cached 10 min) for the repo pickers.
- `GET|POST|PUT /api/sessions/:id/tags` — session tag read/append/replace.
- `GET /api/sessions` — additionally proxies `category`, `repo_names`, `tags`,
  `session_ids`, `created_after/before`, `updated_after` filters.
- `GET /api/local/sessions` — indexes local Devin Desktop/CLI sessions by joining
  `~/Library/Application Support/Devin/User/globalStorage/state.vscdb`
  (`windsurf.acp.*` keys) with the per-session ACP transcript databases in
  `acp-messages/*.db`. Read-only; cached 30s; works while Devin is running
  (WAL-safe opens).
- `GET /api/local/sessions/:uuid` — parses a transcript db into a message list
  (user/agent/thought/tool_call/plan), text payloads only — no file contents or
  tool output blobs beyond titles.
- `POST /api/local/sessions/:id/prompt` — resumes the session via a spawned
  `devin acp` process (JSON-RPC stdio): `initialize` → `authenticate` (session
  token from `~/.local/share/devin/credentials.toml`) → `session/load` →
  `session/prompt`. One job per session; `session/update` notifications feed
  the live view. Locked (open-in-Desktop) sessions return a clear error.
- `GET /api/local/jobs/:id` — prompt job status, captured output and streamed
  messages.

## Security notes

- Anyone with the password can spend your Devin quota. Use a long, unique one. Login is rate limited (8 failures / 15 min / IP).
- Only a fixed set of endpoints is proxied; the browser cannot call anything else on the Devin API.
- Use a service user with the minimum role. If the key leaks, revoke it in Settings > Devin API.
- Don't commit `.env` or `projects.json`/`data/` (all gitignored).

## Notes

- Devin API v3 is used. "Terminate" is permanent; "Sleep & archive" is reversible, and sending a message to a sleeping session resumes it.
- The cloud API only knows about cloud sessions — Devin Desktop/IDE sessions are stored locally on your Mac and show up under the **Local** tab, grouped by project directory. The server must run on the Mac where Devin Desktop is installed for that tab to work (it reads `~/Library/Application Support/Devin/`).
- Approving a "waiting for approval" action isn't exposed by the session API, so the app tells you and links you to the Devin web app for that.
- The app polls (4s in a session, 15s on the list, 60s on the dashboard) while it's open; nothing runs in the background, so there are no push notifications.
- History beyond 10,000 live + 10,000 archived sessions is marked "truncated" in the footer.
