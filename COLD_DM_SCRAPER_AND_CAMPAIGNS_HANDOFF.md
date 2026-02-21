# Cold DM VPS – Scraper and Campaigns Handoff

**Use this document in the Cold DM Cursor project** after the base handoff ([COLD_DM_HANDOFF.md](./COLD_DM_HANDOFF.md)) is implemented. It adds:

1. **Follower scraping** – separate scraper account/session, scrape jobs, writing leads with `source = 'followers:<target_username>'`.
2. **Campaigns** – campaigns with a message template and a list of leads; sender loop sends per campaign and records `campaign_id` on sent messages.

The setter dashboard will call new VPS endpoints via the same Edge Function proxy (`cold-dm-vps-proxy`); the proxy forwards to your VPS using the same `COLD_DM_VPS_URL` and `COLD_DM_API_KEY`.

---

## 1. New tables (Supabase)

The dashboard applies migrations that create these. You only need to **read/write** them from the VPS. If you need to recreate in another project, use the SQL in section 6.

### 1.1 cold_dm_scraper_sessions

Separate Instagram session for the **scraper account** (recommended: different from the account used for sending DMs).

| Column             | Type      | Nullable |
|--------------------|-----------|----------|
| id                 | UUID      | NO (PK)  |
| client_id          | UUID      | NO (UNIQUE) |
| session_data       | JSONB     | NO       |
| instagram_username | TEXT      | YES      |
| updated_at         | TIMESTAMPTZ | YES    |

One row per client. Same format as `cold_dm_instagram_sessions`: store session/cookies only, never password.

### 1.2 cold_dm_scrape_jobs

One row per scrape run (follower scrape).

| Column          | Type      | Nullable |
|-----------------|-----------|----------|
| id              | UUID      | NO (PK)  |
| client_id       | UUID      | NO       |
| target_username | TEXT      | NO       |
| status          | TEXT      | NO       |
| scraped_count   | INT       | NO (default 0) |
| error_message   | TEXT      | YES      |
| started_at      | TIMESTAMPTZ | YES    |
| finished_at     | TIMESTAMPTZ | YES    |

- **status:** `running` | `completed` | `failed` | `cancelled`.
- Index: `(client_id, started_at DESC)` so dashboard can show latest jobs.

### 1.3 cold_dm_campaigns

| Column              | Type      | Nullable |
|---------------------|-----------|----------|
| id                  | UUID      | NO (PK)  |
| client_id           | UUID      | NO       |
| name                | TEXT      | NO       |
| message_template_id | UUID      | YES (FK → cold_dm_message_templates.id) |
| status              | TEXT      | NO       |
| created_at          | TIMESTAMPTZ | YES    |
| updated_at          | TIMESTAMPTZ | YES    |

- **status:** `draft` | `active` | `paused` | `completed`. Only `active` campaigns are processed by the sender.
- Index: `(client_id)`.

### 1.4 cold_dm_campaign_leads

Which leads are in which campaign and their send status.

| Column       | Type      | Nullable |
|--------------|-----------|----------|
| id           | UUID      | NO (PK)  |
| campaign_id  | UUID      | NO (FK → cold_dm_campaigns.id, ON DELETE CASCADE) |
| lead_id      | UUID      | NO (FK → cold_dm_leads.id) |
| status       | TEXT      | NO       |
| sent_at      | TIMESTAMPTZ | YES    |

- **status:** `pending` | `sent` | `failed`.
- UNIQUE `(campaign_id, lead_id)`.
- Indexes: `(campaign_id, status)`, `(lead_id)`.

### 1.5 cold_dm_sent_messages (new column)

- **campaign_id** (UUID, nullable, FK → cold_dm_campaigns.id).

Existing rows stay `NULL`. New sends from the campaign-aware loop should set `campaign_id` to the campaign being used.

---

## 2. Scraper API (VPS endpoints)

Dashboard calls these via the proxy with the same auth (JWT + `clientId`). All request bodies are JSON. Use the same `Authorization: Bearer <COLD_DM_API_KEY>` (or whatever the proxy sends) for server-to-server calls.

### 2.1 POST /api/scraper/connect

- **Body:** `{ "username": "...", "password": "...", "clientId": "uuid" }`
- **Behaviour:**
  1. Log into Instagram with Puppeteer (or your flow) using `username` and `password`.
  2. Extract session only (cookies etc.); do **not** store the password anywhere.
  3. Upsert `cold_dm_scraper_sessions` by `client_id` (from `clientId`):
     - `session_data` = session JSON
     - `instagram_username` = Instagram username
     - `updated_at` = now()
  4. Return `{ "ok": true }` or `{ "ok": false, "error": "..." }`.

### 2.2 GET /api/scraper/status (or POST with body)

- **Query or body:** `clientId` (UUID).
- **Behaviour:** Read `cold_dm_scraper_sessions` for that `client_id` and the latest `cold_dm_scrape_jobs` row (e.g. order by `started_at DESC`, limit 1).
- **Return:**  
  `{ "connected": true | false, "instagram_username": "..." }`  
  and optionally current job:  
  `{ "currentJob": { "id": "uuid", "target_username": "...", "status": "running"|"completed"|"failed"|"cancelled", "scraped_count": 123 } }`

### 2.3 POST /api/scraper/start

- **Body:** `{ "clientId": "uuid", "target_username": "account_to_scrape" }`
- **Behaviour:**
  1. Ensure a row exists in `cold_dm_scraper_sessions` for `client_id`; if not, return `{ "ok": false, "error": "Scraper not connected" }`.
  2. Insert into `cold_dm_scrape_jobs`: `client_id`, `target_username`, `status = 'running'`, `started_at = now()`, `scraped_count = 0`. Get `id` as `jobId`.
  3. Start the follower scrape in the **background** (do not block the HTTP response):
     - Load scraper session from `cold_dm_scraper_sessions`.
     - Navigate to Instagram profile of `target_username`, open followers list, paginate and collect usernames.
     - For each username: upsert into `cold_dm_leads` with `client_id`, `username` (normalised, no @), `source = 'followers:' + target_username`. Use `ON CONFLICT (client_id, username) DO NOTHING` (or equivalent) so existing leads are not duplicated.
     - Periodically update the job row: `scraped_count`, and on finish set `status = 'completed'`, `finished_at = now()`; on error set `status = 'failed'`, `error_message = <message>`.
  4. If the job is cancelled (see stop), set `status = 'cancelled'` and stop paginating.
  5. Return immediately: `{ "ok": true, "jobId": "uuid" }`.

**Rate limiting / safety:** Use delays between follower-list requests (e.g. 2–5 seconds, randomised). Avoid burst traffic to reduce risk of blocks.

### 2.4 POST /api/scraper/stop

- **Body:** `{ "clientId": "uuid", "jobId": "uuid" }` — `jobId` optional.
- **Behaviour:** If `jobId` is provided, update that row in `cold_dm_scrape_jobs` to `status = 'cancelled'`. If not, find the latest row for that `client_id` with `status = 'running'` and set it to `cancelled`. The running scrape process must poll this table (or a shared flag) and exit pagination when it sees `cancelled`.

---

## 3. Campaign-aware sender loop

The existing DM sender loop should be updated so that it sends in the context of **campaigns**.

### 3.1 Picking work

- For the given `client_id`:
  1. Read `cold_dm_control`; if `pause = 1`, do not send.
  2. Select campaigns where `status = 'active'` (e.g. order by `created_at`). For each active campaign:
     - Get the campaign's `message_template_id`; fetch `message_text` from `cold_dm_message_templates`. If no template or missing, skip this campaign or use a fallback.
     - Select one row from `cold_dm_campaign_leads` where `campaign_id = <campaign.id>` and `status = 'pending'` (e.g. order by `id` or `created_at`, limit 1). Join `cold_dm_leads` to get `username`.
  3. If you support only one "current" client per process, pick one pending lead across all active campaigns (e.g. round-robin or oldest first). Send one DM per loop iteration as today.

### 3.2 Sending and recording

- Send the DM using the **campaign's** message text and the lead's `username` (same Instagram session as today — `cold_dm_instagram_sessions`).
- Insert into `cold_dm_sent_messages`: `client_id`, `username`, `message`, `sent_at`, `status` ('success' or 'failed'), and **`campaign_id`** = the campaign's id.
- Update the chosen `cold_dm_campaign_leads` row: set `status = 'sent'` or `'failed'`, and `sent_at = now()` when sent.
- Update `cold_dm_daily_stats` and any other existing counters as you do today.

Respect existing limits from `cold_dm_settings` (daily_send_limit, min/max delay, max_sends_per_hour). No new env vars required.

---

## 4. Optional: human-like ("warm") behaviour

To make the scraper or sender session look less robotic, you can add light activity with random delays:

- **Examples:** Scroll the feed a few times, like 1–3 posts, open a post and scroll comments.
- **When:** Before/after a scrape run, or between DM batches, or on a timer when idle (e.g. every N minutes). Keep frequency low (e.g. a few actions per 10–15 minutes).
- **Implementation:** In the VPS only; no new endpoints or dashboard fields. Use the same session (scraper or sender) and the same browser context; add random delays (e.g. 10–30 s between actions).

---

## 5. Summary for Cold DM repo

1. **Scraper tables:** `cold_dm_scraper_sessions`, `cold_dm_scrape_jobs`. Use scraper session only for scraping; never store password.
2. **Scraper API:** Implement `POST /api/scraper/connect`, `GET /api/scraper/status`, `POST /api/scraper/start`, `POST /api/scraper/stop`. Follower scrape writes to `cold_dm_leads` with `source = 'followers:<target_username>'` and updates `cold_dm_scrape_jobs`.
3. **Campaign tables:** `cold_dm_campaigns`, `cold_dm_campaign_leads`; add `campaign_id` to `cold_dm_sent_messages` when sending from a campaign.
4. **Sender loop:** Choose work from active campaigns and pending `cold_dm_campaign_leads`; send campaign's template; record `campaign_id` on `cold_dm_sent_messages` and update `cold_dm_campaign_leads.status` and `sent_at`.
5. **Optional:** Add warm behaviour (scroll, like, view comments) in the VPS for scraper or sender session.

---

## 6. SQL reference (new objects only)

Use this only if you need to recreate the new objects in another Supabase project. The setter dashboard will have already applied migrations in the shared project.

```sql
-- Scraper session (one per client)
CREATE TABLE public.cold_dm_scraper_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL UNIQUE,
  session_data JSONB NOT NULL,
  instagram_username TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_cold_dm_scraper_sessions_client_id ON public.cold_dm_scraper_sessions(client_id);

-- Scrape jobs
CREATE TABLE public.cold_dm_scrape_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  target_username TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  scraped_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_cold_dm_scrape_jobs_client_started ON public.cold_dm_scrape_jobs(client_id, started_at DESC);

-- Campaigns
CREATE TABLE public.cold_dm_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  name TEXT NOT NULL,
  message_template_id UUID REFERENCES public.cold_dm_message_templates(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_cold_dm_campaigns_client_id ON public.cold_dm_campaigns(client_id);

-- Campaign leads (which leads are in which campaign)
CREATE TABLE public.cold_dm_campaign_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.cold_dm_campaigns(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.cold_dm_leads(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX idx_cold_dm_campaign_leads_campaign_status ON public.cold_dm_campaign_leads(campaign_id, status);
CREATE INDEX idx_cold_dm_campaign_leads_lead_id ON public.cold_dm_campaign_leads(lead_id);

-- Add campaign_id to sent messages
ALTER TABLE public.cold_dm_sent_messages
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES public.cold_dm_campaigns(id);
CREATE INDEX idx_cold_dm_sent_messages_campaign_id ON public.cold_dm_sent_messages(campaign_id)
  WHERE campaign_id IS NOT NULL;
```

RLS: the dashboard will create policies for these tables using the same `cold_dm_can_access(client_id)` pattern. The VPS uses the service role key, so RLS does not apply to the VPS.

Use this handoff together with **COLD_DM_HANDOFF.md** to implement the scraper and campaigns in the Cold DM repo.
