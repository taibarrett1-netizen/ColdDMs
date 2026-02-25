# Dashboard → Cold DM VPS Scraper Connectivity

**Use this handoff in the setter/dashboard repo** to implement the scraper UI that calls the Cold DM VPS. The VPS exposes these endpoints; the dashboard calls them via the `cold-dm-vps-proxy` Edge Function (or directly if running on the same network).

---

## Base URL and auth

- **Base URL:** `COLD_DM_VPS_URL` (e.g. `http://YOUR_VPS_IP:3000` or `https://your-vps-domain.com`)
- **Auth:** All scraper requests must include `Authorization: Bearer <COLD_DM_API_KEY>` (or whatever header the proxy forwards). The VPS validates this before processing.

The proxy forwards requests to the VPS with the same `clientId` from the dashboard context.

---

## Endpoints to implement

### 1. POST /api/scraper/connect

Connect the **scraper** Instagram account (separate from the DM sender account). Password is never stored.

**Request:**
```json
{
  "username": "scraper_instagram_username",
  "password": "scraper_instagram_password",
  "clientId": "uuid-from-dashboard-context"
}
```

**Response:**
- Success: `{ "ok": true }`
- Error: `{ "ok": false, "error": "Login failed" }` (HTTP 500)

**UI:** "Connect Scraper" button. On click, collect username + password in a modal/form, call this endpoint. On success, show "Connected as @username". Do not store the password anywhere.

---

### 2. GET /api/scraper/status

Get scraper connection status and current job. Supports both GET (query) and POST (body) for `clientId`.

**Request (GET):**
```
GET /api/scraper/status?clientId=uuid
```

**Request (POST):**
```json
{
  "clientId": "uuid"
}
```

**Response:**
```json
{
  "connected": true,
  "instagram_username": "scraper_username",
  "currentJob": {
    "id": "job-uuid",
    "target_username": "account_being_scraped",
    "status": "running",
    "scraped_count": 123
  }
}
```

- `currentJob` is omitted if there is no job or the latest job is not active.
- `status` is one of: `running`, `completed`, `failed`, `cancelled`.

**UI:** Poll this periodically when showing the scraper panel. Display: "Connected as @username" or "Not connected". If `currentJob` exists with `status: "running"`, show progress (e.g. "Scraping @target_username... 123 leads so far") and a "Stop" button.

---

### 3. POST /api/scraper/start

Start a follower scrape. Returns immediately; the scrape runs in the background.

**Request:**
```json
{
  "clientId": "uuid",
  "target_username": "account_to_scrape",
  "max_leads": 500
}
```

- `target_username` (required): Instagram username whose followers to scrape (without @).
- `max_leads` (optional): Stop when this many **new** leads have been added. Omit for no limit. Recommended: 200–1000 to avoid long runs and rate limits.

**Response:**
- Success: `{ "ok": true, "jobId": "uuid" }`
- Error: `{ "ok": false, "error": "Scraper not connected" }` (HTTP 400) or other error message.

**UI:** Form with:
- Target username input (required)
- Max leads input (optional, e.g. default 500, or "No limit" checkbox)
- "Start scrape" button. On success, show "Scrape started (job ID: ...)" and begin polling status.

---

### 4. POST /api/scraper/stop

Cancel a running scrape.

**Request:**
```json
{
  "clientId": "uuid",
  "jobId": "optional-job-uuid"
}
```

- `jobId` optional: If provided, cancels that specific job. If omitted, cancels the latest running job for this client.

**Response:**
```json
{
  "ok": true,
  "cancelled": true
}
```

**UI:** "Stop" button next to the running job. Call this when the user clicks Stop.

---

## Proxy integration

If using `cold-dm-vps-proxy`:

1. Ensure `COLD_DM_VPS_URL` and `COLD_DM_API_KEY` are set in Supabase Edge Function secrets.
2. The proxy forwards `/api/scraper/*` to the VPS with the same path and body.
3. The dashboard calls the proxy URL (e.g. your Supabase project URL + `/functions/v1/cold-dm-vps-proxy`) with path `/api/scraper/connect`, `/api/scraper/status`, etc., and includes `clientId` from the current user/tenant context.

**Avoiding 504 (VPS did not respond in time):** The Edge Function must allow enough time for the VPS to reply. The VPS responds to `/api/status` within 8 seconds (or with 503 if its own timeout fires). Use a **proxy timeout of at least 15 seconds** when forwarding to the VPS. For a fast connectivity check without DB/pm2, the proxy can call **GET /api/health** (same auth); the VPS returns `{ ok: true }` immediately.

---

## Quick reference

| Action | Method | Path | Body |
|--------|--------|------|------|
| Connect scraper | POST | /api/scraper/connect | `{ username, password, clientId }` |
| Get status | GET or POST | /api/scraper/status | `clientId` (query or body) |
| Start scrape | POST | /api/scraper/start | `{ clientId, target_username, max_leads? }` |
| Stop scrape | POST | /api/scraper/stop | `{ clientId, jobId? }` |

---

## Notes

- **New leads only:** The VPS upserts into `cold_dm_leads` with `ON CONFLICT DO NOTHING`. Existing leads (same `client_id` + `username`) are not duplicated.
- **max_leads:** Counts newly added leads. The scraper stops when `scraped_count >= max_leads`. Recommend default 500 for safety.
