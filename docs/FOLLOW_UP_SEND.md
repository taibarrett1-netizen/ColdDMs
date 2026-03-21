# Follow-up sends (`POST /api/follow-up/send`)

SkeduleMore **follow-ups** are triggered by the dashboard when a scheduled follow-up runs. The VPS only receives an HTTP request; it does **not** read follow-up configuration from `cold_dm_campaigns`, `cold_dm_message_group_messages`, or any follow-up-specific DB tables.

## Production contract (VPS)

- **Method / path:** `POST /api/follow-up/send` with `Content-Type: application/json` (and `Authorization: Bearer …` when `COLD_DM_API_KEY` is set).
- **Required:** `clientId`, `instagramSessionId`, `recipientUsername` (no `@` required; a leading `@` is stripped).
- **Voice follow-up:** `audioUrl` — **HTTPS** URL the worker **GET**s and saves to a temp file before the voice UI pipeline.
- **Optional with `audioUrl`:** `caption` — one text DM in the same thread **before** the voice note (`bot.js` → `sendPlainTextInThread` then voice).
- **Correlation (optional):** header **`X-Correlation-ID`** or **`X-Request-ID`**, or JSON **`correlationId`** / **`requestId`**. Logged on `[API] follow-up/send` and `[follow-up] …` lines.

**Strict modes:** exactly one of `text`, non-empty `messages[]`, or `audioUrl` (see table below). Implemented in `server.js` (`/api/follow-up/send`) and `sendFollowUp` in `bot.js`.

## Voice notes (follow-ups) — intended behaviour

Instagram **Web** does not expose a reliable “upload this `.wav` as a voice note” API for automation. The worker therefore uses this **single pipeline**:

1. **Download** `audioUrl` to a temp file (e.g. `/tmp/voice-note-….wav`).
2. **Play** that file into a **PulseAudio** virtual sink (`ffmpeg` → `VOICE_NOTE_SINK`, e.g. `ColdDMsVoice`) so Chromium’s default **microphone** capture hears your audio.
3. **Drive the normal IG voice UI**: focus composer → click/hold mic → “record” for the same duration as the file (+ small buffer) → click **Send**.

So logs will always show **both**:

- `Voice playback started (Xs): /tmp/voice-note-…` — ffmpeg feeding PulseAudio  
- `Voice (desktop): click mic, record X ms, then send` — Puppeteer using the mic UI  

That is **not** a bug or a double path (no separate “preview” vs “record”). The download + playback **is** how the audio reaches Instagram as a voice note.

If you pass **`caption`**, the worker sends **one text DM first** (`sendPlainTextInThread`), then the voice pipeline above (`bot.js`: `hasCaption` branch).

## Request body (strict modes)

Exactly **one** of:

| Field | Mode |
|--------|------|
| `text` | Single text DM |
| `messages` | Array of text DMs (sequential) |
| `audioUrl` | Voice follow-up (`caption` optional text before voice) |

## Debug screenshots (optional)

1. Set **`FOLLOW_UP_DEBUG_SCREENSHOTS=true`** in `.env` on the VPS and restart PM2.
2. For **voice** follow-ups, when debug screenshots are on you may get:
   - **`*_voice-mic-click-target.png`** — **before** the mic click, with a **red crosshair** at the exact viewport coordinates used (so you can see if we’re hitting the wrong icon).
   - **`*_voice-recording-ui-missed.png`** — if recording UI never appears after the click, same crosshair on the current page (usually wrong target or blocked mic).
   - **`*_voice-after-mic-click.png`** — after recording UI is confirmed and a short delay (recording strip should be visible).
   Filenames include `correlationId` when sent in the request.
3. **Download via HTTP** (Bearer `COLD_DM_API_KEY` when set): `GET /api/debug/follow-up-screenshots` and `GET /api/debug/follow-up-screenshots/file?name=...`

Optional: **`FOLLOW_UP_SCREENSHOTS_FULL_PAGE=true`** for full-page PNGs.

### Watch the browser on the VPS (VNC + Xvfb)

See **`DEPLOYMENT.md`** → *Watching the browser on a VPS*. Set `HEADLESS_MODE=false`, `DISPLAY=:99` (or your Xvfb display), run `x11vnc`, tunnel with SSH, connect VNC to `localhost:5900`. Use **`PUPPETEER_SLOW_MO_MS=80`** so actions are easier to follow.

### Recording UI gate (desktop)

After clicking the mic, the worker **waits** for Instagram’s recording UI (blue strip, **`0:00`–`0:59`**-style timer in the composer band, or pause/delete recording controls). It **does not** start feeding audio into Pulse/ffmpeg until that passes (so you don’t burn the file while the composer still shows “Message…”). If the UI never appears, you get **`voice_recording_ui_not_detected`** and the debug PNG (if enabled) should still show the idle composer.

Optional env: **`VOICE_RECORDING_UI_TIMEOUT_MS`** (default **12000**) — max wait for that UI after the mic click.

### Stricter success criteria

By default **`VOICE_NOTE_STRICT_VERIFY`** is **on**: after clicking Send, the worker polls the thread until it sees a DOM change (e.g. new `audio` / list rows). If Instagram returns “success” in logs but no bubble appears, you should see a **`voice_not_confirmed_in_thread`** error instead of a false **`sent ok`**. Set **`VOICE_NOTE_STRICT_VERIFY=false`** only if this check causes false failures on your layout.

**Note:** Sending **Escape** after recording was closing Instagram’s voice UI before “Send” — that is no longer done between record and send.

**Recording gesture:** On **desktop Chrome** the mic is usually a **single click** to start; the worker waits for the audio duration (ffmpeg), then clicks **Send**. **Mobile web** viewports use **press-and-hold** on the mic. The VPS resolves the mic via layout (to the right of the message field, leftmost of the three trailing icons) and uses **`element.click()`** on that node so the right control is hit.

## Correlation (Supabase ↔ VPS logs)

Optional, for matching `execute_follow_up` / Edge logs to PM2:

- **Header:** `X-Correlation-ID` or `X-Request-ID`
- **JSON body:** `correlationId` or `requestId`

These are logged on `[API] follow-up/send` and `[follow-up] start` / `sent ok` / `failed` / `exception` lines as `correlationId=…`.

## Does `mode=voice` send scripted text?

**Not unless you include `caption`.** For `audioUrl` only (empty caption), `sendFollowUp` in `bot.js` does **not** call `sendPlainTextInThread`. It only navigates to the thread, then runs the voice pipeline.

If you see **duplicate opener-style text** in the thread:

- Check the dashboard isn’t **retrying** the same follow-up HTTP call (5xx retries).
- Check no **second** job (cold DM campaign, another follow-up) ran for the same user.
- This worker does not re-run “saved reply” or campaign templates on follow-up unless you sent `text` / `messages` / `caption`.

## What the debug screenshots showed (common issues)

- **Home (`01-home`):** If a **“Turn on Notifications”** modal is visible, it blocks the rest of the session until dismissed. The worker now clicks **Not Now** on that (and similar) modals **before** the `01-home` screenshot.
- **Composer (`04`):** A **sticker / GIF panel** over the thread steals clicks from the real mic/send. The worker now sends **Escape** several times before voice actions and **excludes emoji/sticker/GIF controls** when resolving the mic. The send step prefers **voice send** controls and avoids sticker regions.

## VPS requirements (voice)

- **`ffmpeg` and `ffprobe`** must be installed (`sudo apt install ffmpeg`). Without them the dashboard process can crash with `spawn ffmpeg ENOENT` when sending voice.
- **PulseAudio** null sink + `VOICE_NOTE_*` env (see `DEPLOYMENT.md`) for piping audio into the browser capture device.

## Logging

- **Dashboard (`server.js`):** Each request logs `[API] follow-up/send request …` and a line for `response ok=true/false` (see `pm2 logs ig-dm-dashboard` or `logs/bot.log` — same logger writes to stdout and `logs/bot.log`).
- **Send path (`bot.js`):** `[follow-up] start …` after session validation, `[follow-up] sent ok …` on success, and `[follow-up] failed …` / `[follow-up] exception …` on errors. Signed `audioUrl` values are not logged.

## Cold DM campaign voice (separate)

Voice for **cold outreach campaigns** may use `cold_dm_campaigns` / `cold_dm_message_group_messages` columns (see migration `010_voice_notes.sql`) and env `VOICE_NOTE_*` on the worker. That path is **independent** from follow-up sends.
