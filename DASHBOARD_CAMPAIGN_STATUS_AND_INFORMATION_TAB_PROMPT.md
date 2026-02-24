# Prompt for dashboard repo: Campaign status + Information tab

Use this in the **dashboard repo** to add a clearer campaign status and an Information tab for Cold DM.

---

## 1. Status message from VPS

The Cold DM VPS now **writes a short status message** per client and exposes it on **GET /api/status**.

- **Query:** `GET /api/status?clientId=<uuid>` (same as today).
- **New field in response:** `statusMessage` (string or null).
- **Examples:**  
  `"Sending…"`  
  `"Waiting. Next send in 4 min."`  
  `"Hourly limit reached. Next send in ~60 min."`  
  `"Daily limit reached."`  
  `null` when there’s no recent status.

When **pause = 1** (client stopped), the dashboard can show **"Paused"** even if `statusMessage` is old or null.

**Database (optional):** If the dashboard reads Supabase directly instead of only the VPS API, the same text is in `cold_dm_control.status_message` (and `status_updated_at`). Run this migration in the same Supabase project if you use that table:

```sql
ALTER TABLE public.cold_dm_control
  ADD COLUMN IF NOT EXISTS status_message TEXT,
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
```

---

## 2. What to build in the dashboard

### 2.1 Campaign / control status

- **Where:** On the Cold Outreach / campaign view where you currently show “Active” (or similar).
- **Change:**  
  - If the client is **paused** (`cold_dm_control.pause = 1` or equivalent from your API): show **“Paused”**.  
  - Else show the **status message** from the API:  
    - If `statusMessage` is present, show it as the main status (e.g. “Sending…”, “Waiting. Next send in 4 min.”, “Hourly limit reached. Next send in ~60 min.”, “Daily limit reached.”).  
    - If `statusMessage` is null/empty, you can keep showing “Active” or “Running” as fallback.
- So the user sees one of: **Paused** | **Sending…** | **Waiting. Next send in X min.** | **Hourly limit reached. Next send in ~60 min.** | **Daily limit reached.** | **Active** (fallback).

### 2.2 “Information” tab

- **Where:** Inside the same Cold DM / campaign area where you currently show stats and controls.
- **Add:** A second tab (e.g. “Information” or “Details”) **next to** the current main tab.
- **Current content:** Move the existing stats/details (e.g. today sent, today failed, leads total, leads remaining, or whatever you show there now) **into this new “Information” tab** so the main view is less cluttered.
- **Add in the same tab:**  
  - The **longer status message** (same as in 2.1: e.g. “Sending…”, “Waiting. Next send in 4 min.”, “Hourly limit reached. Next send in ~60 min.”, “Daily limit reached.”, or “Paused” when paused).  
  - Optionally **status_updated_at** if you read it from Supabase (e.g. “Last updated: 2 min ago”).
- So “Information” = **one place** for:  
  - The detailed status line (and optionally timestamp).  
  - All the existing stats/info you already have for that campaign/client.

### 2.3 Summary

- **Main view:** Keep a short status (Paused | statusMessage | Active).  
- **Information tab:** Move existing data there + show the same status message (and optionally when it was updated).  
- **Data source:** `GET /api/status?clientId=...` with `statusMessage`; optionally Supabase `cold_dm_control.status_message` and `status_updated_at` if you use them.

Use this to implement the new status display and the Information tab in the dashboard.
