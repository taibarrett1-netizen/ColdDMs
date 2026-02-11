# Prompt to Paste in Your Setter / Lovable Cursor Project

Copy everything below the line into the other Cursor project (the AI setter on Lovable) to integrate the Cold Outreach module.

---

I'm adding a **Cold Outreach** module to this app. It should appear as a **tab** (e.g. "Cold Outreach") in the same webpage as the rest of the setter UI—not a separate app. There is no local or standalone Cold DM mode.

**Please read the integration guide:** `INTEGRATION.md` (from the Cold DM repo; I've added it to this project at [path to INTEGRATION.md]).

Then implement the following:

1. **Supabase (same project we already use for setter settings and conversations)**  
   Create the Cold DM tables described in INTEGRATION.md (e.g. `cold_dm_message_templates`, `cold_dm_leads`, `cold_dm_settings`, `cold_dm_instagram_sessions`, `cold_dm_sent_messages`, `cold_dm_daily_stats`, `cold_dm_control`). Use RLS so only the correct user/tenant can access their data. All Cold DM data (outreach messages, leads, settings, sent log, stats) lives here so we stay in sync with the VPS and can share data with the setter (e.g. leads, conversations).

2. **Cold Outreach tab (same app, same webpage)**  
   Build the Cold Outreach UI as a tab in the setter:
   - **Connect Instagram:** Form (username + password) only when connecting or reconnecting. When user submits, our **backend** calls the VPS `POST /api/instagram/connect` with the credentials. We **never store** the Instagram password—only the VPS uses it once to log in and save a session to Supabase. Show "Connected as @username" when a session exists; "Reconnect" when not. So we can truthfully say: **"We do not store your Instagram password."**
   - **Settings:** Daily limit, min/max delay, max per hour. Save to Supabase (`cold_dm_settings`).
   - **Message templates:** List/edit outreach messages. Save to Supabase (`cold_dm_message_templates`).
   - **Leads:** Add/edit/paste/upload usernames to DM. Save to Supabase (`cold_dm_leads`).
   - **Sent:** Table or list from Supabase (`cold_dm_sent_messages`).
   - **Dashboard:** Today sent/failed, leads total/remaining (from Supabase), **Start** and **Stop** buttons (our backend calls VPS `POST /api/control/start` and `POST /api/control/stop`), **Reset failed** (clear failed rows in Supabase and update daily stats). Poll or refresh status (our backend calls VPS `GET /api/status`) so we show whether the bot process is running.

3. **Backend**  
   - Store `COLD_DM_VPS_URL` and `COLD_DM_API_KEY` in env.  
   - Implement server-side calls to the VPS **only** for: **GET /api/status**, **POST /api/control/start**, **POST /api/control/stop**, **POST /api/instagram/connect** (with username and password in body). Send the API key on every request (e.g. `Authorization: Bearer <key>`). Do not expose the API key or VPS URL to the frontend.  
   - All other Cold DM data (templates, leads, settings, sent, stats): read and write **Supabase** from our backend or frontend. Do not proxy these through the VPS—Lovable and VPS stay in sync by both using the same Supabase project.

4. **Security**  
   Use HTTPS. Never store Instagram password. Only send it once to the VPS for the connect flow; the VPS saves only the session to Supabase. No Puppeteer or bot code in this repo—only UI, Supabase, and HTTP calls to the VPS for start/stop/status/connect.

5. **Handoff for the Cold DM repo**  
   When you are done, produce a **handoff document** that I can copy and give to the **Cold DM Cursor project** (the VPS repo) so it can implement the Supabase changes and the connect endpoint there. Follow **INTEGRATION.md section 11** exactly: the handoff must include Supabase connection (env vars), exact table and column names for every Cold DM table you created, how session is stored (table + format), connect endpoint behavior, where the pause flag lives and how status is returned, and any SQL/migrations you used. Output it as a single markdown or text block I can paste into the Cold DM repo and say: “Use this to implement the Supabase changes and the connect endpoint.”

Follow the architecture, Supabase schema, and checklist in INTEGRATION.md. The VPS will be adapted separately using the handoff you produce; our job is the Cold Outreach tab, Supabase tables, backend that talks to the VPS for control and connect, and the handoff document for the Cold DM Cursor.

b12c9af6cda400a483c7d03a99e9f771c4eed254501ceb202bd65b8589f43354