# Cold DM Module – Integration Guide for Lovable / AI Setter

This document is for **another app** (e.g. a Lovable-built AI appointment setter) that wants to add **Cold DMs** as a module. The Cold DM **logic and execution** stay on a **VPS**; your app provides the **UI** and talks to the VPS over HTTP.

**Audience:** Developers or an AI model integrating this module into a parent application (e.g. Lovable).

---

## 1. What This Module Does

- **Instagram cold DMs:** Logs into Instagram (username/password or persisted session), reads a list of leads (usernames), and sends them DMs with configurable message templates.
- **Runs 24/7 on a VPS** via PM2 (Node + Puppeteer/Chromium). No browser extension; the bot runs headless on the server.
- **API server** (same process or same box) exposes REST endpoints for status, settings, leads, messages, start/stop, and reset-failed. Your Lovable app calls these endpoints to drive the UI; it does **not** run the bot or store Instagram credentials.

---

## 2. Architecture: What Runs Where

| Component | Where it runs | Notes |
|-----------|----------------|--------|
| **Bot process** | VPS only | `cli.js` → `bot.js`, PM2, Chromium. Reads `.env`, `leads.csv`, SQLite. |
| **API server** | VPS only | `server.js` (Express). Serves the API used by the dashboard (or by your Lovable app). |
| **Database** | VPS only | SQLite `database/bot.db` (sent_messages, daily_stats, control). |
| **Credentials & leads** | VPS only | `.env` (Instagram user/pass, limits), `leads.csv`, `config/messages.js`. |
| **Cold DM UI** | Your app (Lovable) | Screens you build: status, settings, leads, sent list, start/stop, reset failed. All data comes from the VPS API. |

**Important:** Your Lovable app must **never** run Puppeteer or store Instagram passwords. It only stores the **VPS API base URL** and (recommended) an **API key**, and proxies or forwards requests to the VPS.

---

## 3. How the Bot Works (High-Level)

1. **Start** – PM2 starts `cli.js --start`. Bot loads leads from CSV, filters out usernames already in `sent_messages`, then opens a browser (Chromium) with optional persistent profile (`.browser-profile`).
2. **Login** – Goes to Instagram login; if session exists (cookies in profile), skips login (“Already logged in”). Otherwise types username/password from `.env`, submits, dismisses “Save login” / “Not now” modals.
3. **Send loop** – For each remaining lead: navigates to `direct/new/`, finds search input (by placeholder/visibility), types username, selects the **matching** user (by username text), clicks “Message”/“Next” to open thread, finds compose area (textarea or contenteditable/role=textbox), types a random message from `config/messages.js`, sends. Logs success/failure to SQLite and updates daily_stats. Waits a random delay (MIN_DELAY–MAX_DELAY minutes) between sends; first send after a short (5–60s) delay.
4. **Control** – A `control` table has a `pause` flag. Start clears it; Stop sets it. The bot checks this before each send and exits the loop if paused.
5. **Persistence** – Browser profile dir (`.browser-profile`) keeps cookies so the bot doesn’t log in every run; “Reset failed” clears failed rows from `sent_messages` so those leads can be retried.

Your UI only needs to call the API; the VPS handles all of the above.

---

## 4. Connecting the VPS to Your Lovable UI (Securely)

### 4.1 Expose the VPS API

- The API runs on the VPS (e.g. `http://localhost:3000`). To be called by Lovable (or your backend), it must be reachable over the internet.
- **Recommended:** Put **nginx** (or Caddy) in front of the Node app, bind to a subdomain (e.g. `colddm-api.yourdomain.com`), and use **HTTPS** (e.g. Let’s Encrypt). Example nginx concept:

```nginx
server {
  listen 443 ssl;
  server_name colddm-api.yourdomain.com;
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

- Open firewall for 443 (and 80 if you use HTTP→HTTPS redirect). Do **not** expose the bot’s port to the whole internet without auth (next section).

### 4.2 Add API Key Auth (Recommended)

The VPS API **currently has no authentication**. For Lovable (or any external client), you should add a simple API key check so only your app can call it.

- **On the VPS:** Set an env var, e.g. `COLD_DM_API_KEY=your-long-random-secret`. The server expects the client to send this on every request (e.g. header `Authorization: Bearer <key>` or `X-API-Key: <key>`). If `COLD_DM_API_KEY` is set, requests without a valid key get 401.
- **In Lovable:** Store the VPS base URL and the same API key in your backend env (e.g. `COLD_DM_VPS_URL`, `COLD_DM_API_KEY`). Have your **backend** call the VPS (server-to-server); do not put the API key in frontend code. Your backend then exposes its own endpoints or proxies to the VPS so the frontend only talks to your backend.

### 4.3 CORS (If Lovable Frontend Calls VPS Directly)

If the **browser** (Lovable frontend) calls the VPS API directly (not recommended if you can use a backend):

- Enable CORS on the VPS API for your Lovable origin (e.g. `https://your-app.lovable.app`). In Express you’d use the `cors` package and restrict `origin` to that domain.
- Prefer **backend-to-VPS** so the API key and VPS URL stay on the server.

---

## 5. API Reference (VPS)

Base URL: `https://colddm-api.yourdomain.com` (or whatever you use). All responses are JSON unless noted.

**Authentication (when enabled):**  
Send the API key in every request, e.g.  
`Authorization: Bearer YOUR_API_KEY`  
or  
`X-API-Key: YOUR_API_KEY`

---

### 5.1 Status (dashboard home)

**GET** `/api/status`

**Response:**

```json
{
  "processRunning": true,
  "todaySent": 5,
  "todayFailed": 1,
  "leadsTotal": 100,
  "leadsRemaining": 94
}
```

- `processRunning`: whether the PM2 bot process is online.
- `todaySent` / `todayFailed`: from `daily_stats` for today.
- `leadsTotal`: number of lines in leads CSV (after header).
- `leadsRemaining`: leads not yet in `sent_messages`.

---

### 5.2 Stats

**GET** `/api/stats`

**Response:** Same shape as `getDailyStats()`:

```json
{
  "date": "2026-02-11",
  "total_sent": 5,
  "total_failed": 1
}
```

---

### 5.3 Sent messages (history)

**GET** `/api/sent?limit=50`

**Query:** `limit` (optional, default 50, max 200).

**Response:** Array of:

```json
[
  {
    "username": "skedulemore",
    "message": "Quick question...",
    "sent_at": "2026-02-11T02:50:05.776Z",
    "status": "success"
  }
]
```

---

### 5.4 Settings (read)

**GET** `/api/settings`

**Response:** Key-value of env vars. Password is masked:

```json
{
  "INSTAGRAM_USERNAME": "myuser",
  "INSTAGRAM_PASSWORD": "********",
  "DAILY_SEND_LIMIT": "100",
  "MIN_DELAY_MINUTES": "5",
  "MAX_DELAY_MINUTES": "30",
  "MAX_SENDS_PER_HOUR": "20",
  "HEADLESS_MODE": "true",
  "LEADS_CSV": "leads.csv"
}
```

---

### 5.5 Settings (write)

**POST** `/api/settings`  
**Body:** JSON object with any of the keys below. Omit keys you don’t want to change. Send `********` for password to leave it unchanged.

```json
{
  "INSTAGRAM_USERNAME": "myuser",
  "INSTAGRAM_PASSWORD": "secret",
  "DAILY_SEND_LIMIT": "50",
  "MIN_DELAY_MINUTES": "5",
  "MAX_DELAY_MINUTES": "30",
  "MAX_SENDS_PER_HOUR": "20",
  "HEADLESS_MODE": "true",
  "LEADS_CSV": "leads.csv"
}
```

**Response:** `{ "ok": true }`

---

### 5.6 Message templates (read)

**GET** `/api/messages`

**Response:**

```json
{
  "messages": [
    "Hey, saw your post—cool stuff!",
    "Quick question about your content..."
  ]
}
```

---

### 5.7 Message templates (write)

**POST** `/api/messages`  
**Body:**

```json
{
  "messages": ["Message one", "Message two"]
}
```

`messages` must be a non-empty array. Overwrites `config/messages.js` on the VPS.

**Response:** `{ "ok": true }`  
**Error (400):** `{ "error": "messages must be a non-empty array" }`

---

### 5.8 Leads (read)

**GET** `/api/leads`

**Response:**

```json
{
  "usernames": ["user1", "user2"],
  "raw": "username\nuser1\nuser2"
}
```

`raw` is the full CSV content (header + usernames).

---

### 5.9 Leads (write from text)

**POST** `/api/leads`  
**Body:**

```json
{
  "raw": "user1\nuser2\n@user3"
}
```

Replaces `leads.csv` with a header `username` and one username per line. Leading `@` is stripped.

**Response:** `{ "ok": true, "count": 3 }`

---

### 5.10 Leads (upload CSV file)

**POST** `/api/leads/upload`  
**Content-Type:** `multipart/form-data`  
**Body:** One file field (e.g. `file`). File can be CSV with optional header line `username` or `user`; other lines are usernames (with or without `@`).

**Response:** `{ "ok": true, "count": 42 }`  
**Error (400):** `{ "error": "No file uploaded" }`

---

### 5.11 Start bot

**POST** `/api/control/start`

Sets pause flag to 0 and runs `pm2 start cli.js --name ig-dm-bot -- --start` (or equivalent). Idempotent if already running.

**Response:** `{ "ok": true, "processRunning": true }`  
**Error (500):** `{ "ok": false, "error": "..." }`

---

### 5.12 Stop bot

**POST** `/api/control/stop`

Sets pause flag to 1 and runs `pm2 stop ig-dm-bot`.

**Response:** `{ "ok": true, "processRunning": false }`  
**Error (500):** `{ "ok": false, "error": "..." }`

---

### 5.13 Reset failed (retry failed leads)

**POST** `/api/reset-failed`

Deletes all rows in `sent_messages` with `status = 'failed'` and sets today’s `total_failed` to 0. Those leads then count as “remaining” again.

**Response:** `{ "ok": true, "cleared": 2 }`  
**Error (500):** `{ "ok": false, "error": "..." }`

---

## 6. VPS Environment and Files

**Env vars** (in `.env` on the VPS):

| Variable | Purpose |
|----------|--------|
| `INSTAGRAM_USERNAME` | Instagram login |
| `INSTAGRAM_PASSWORD` | Instagram password |
| `DAILY_SEND_LIMIT` | Max sends per day (e.g. 100) |
| `MIN_DELAY_MINUTES` | Min minutes between sends |
| `MAX_DELAY_MINUTES` | Max minutes between sends |
| `MAX_SENDS_PER_HOUR` | Hourly cap |
| `HEADLESS_MODE` | `true` for headless Chromium |
| `LEADS_CSV` | Path to CSV file (default `leads.csv`) |
| `DASHBOARD_PORT` | Port for Express (default 3000) |
| `COLD_DM_API_KEY` | Optional; if set, API requires this key (see Security) |

**Important paths on VPS (relative to project root):**

- `leads.csv` – lead usernames (first line can be `username`, then one per line).
- `config/messages.js` – message templates (array `MESSAGES`); written by POST `/api/messages`.
- `database/bot.db` – SQLite DB (sent_messages, daily_stats, control).
- `.browser-profile/` – Chromium profile (cookies/session); do not commit.

**Deployment:** See `DEPLOYMENT.md` in this repo (Node, Chromium deps, PM2, firewall). For external access, add HTTPS and API key as in section 4.

---

## 7. Lovable Integration Checklist

Use this when building the Cold DM section in your AI setter / Lovable app:

1. **Backend**
   - Add env: `COLD_DM_VPS_URL` (e.g. `https://colddm-api.yourdomain.com`), `COLD_DM_API_KEY` (same as on VPS).
   - Implement server-side calls to the VPS for every action (status, settings, leads, messages, start, stop, reset-failed, sent). Forward or proxy requests; add the API key header. Do not expose the API key to the frontend.

2. **Frontend (Cold DM “module” screens)**
   - **Dashboard:** Show status (running/stopped), today sent/failed, leads total/remaining; Start and Stop buttons; Reset failed button. Poll or refresh status periodically (e.g. GET `/api/status` via your backend).
   - **Settings:** Form for Instagram username, password (optional change), daily limit, min/max delay, max per hour, headless. Save via POST `/api/settings` (via your backend).
   - **Messages:** List/edit message templates; load GET `/api/messages`, save POST `/api/messages`.
   - **Leads:** Text area or file upload; load GET `/api/leads`, save POST `/api/leads` or POST `/api/leads/upload`.
   - **Sent:** Table or list from GET `/api/sent?limit=...`.

3. **Security**
   - All calls from Lovable to the VPS go through **your backend** with the API key. HTTPS on the VPS. No Instagram credentials stored in Lovable; they stay in the VPS `.env`.

4. **No bot code in Lovable**
   - Lovable does not run Puppeteer, Chromium, or the bot. It only consumes the VPS API and renders the UI.

---

## 8. Repo Structure (This Module)

```
Cold DMs V1/
├── INTEGRATION.md     ← This file (give to the other Cursor/Lovable project)
├── DEPLOYMENT.md      ← VPS setup (Node, Chromium, PM2, env)
├── README.md          ← General project readme
├── server.js          ← Express API + optional API key middleware
├── bot.js             ← Puppeteer login + send flow (VPS only)
├── cli.js             ← PM2 entry (--start, --status, etc.)
├── config/
│   └── messages.js   ← Message templates (written by API)
├── database/
│   └── db.js          ← SQLite (sent_messages, daily_stats, control)
├── public/
│   └── index.html    ← Standalone dashboard (replace by Lovable UI)
├── utils/
│   └── logger.js
├── leads.csv.example
├── .env.example
└── package.json
```

The other project needs **INTEGRATION.md** (this file) and, if it will deploy the VPS side, the rest of the repo (or a clone). The Lovable app only needs to implement the API client and UI described above.

---

## 9. API Key Auth (Implemented)

This repo already includes optional API key auth in `server.js`. If you set **`COLD_DM_API_KEY`** in the VPS `.env`, all `/api/*` requests must include that value in the **`Authorization: Bearer <key>`** or **`X-API-Key: <key>`** header; otherwise the server responds with **401 Unauthorized**. If `COLD_DM_API_KEY` is unset, the API is open (e.g. for the built-in dashboard on the same machine). Your Lovable backend should send the same key on every request to the VPS.
