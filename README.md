# Cold DM / Instagram outreach (VPS + dashboard)

Node.js app: **web dashboard** (`server.js`), **send worker** (`workers/send-worker.js` → `bot.js` multi-tenant loop), optional **scrape worker** (`workers/scrape-worker.js`). Uses **Supabase** for campaigns, leads, sessions, send queue, and pause flags.

## Do not use `ig-dm-bot`

Production must run **`ig-dm-send`** only (from `ecosystem.config.cjs` or `pm2 start workers/send-worker.js --name ig-dm-send …`). The old name **`ig-dm-bot`** (`cli.js --start` under PM2) duplicates the same send loop and **breaks Chrome** (“browser is already running” on the same persistent profile). If you still have it: `pm2 delete ig-dm-bot && pm2 save`.

**Local dev** without PM2: `node cli.js --start` is fine (no `name=ig-dm-bot`).

## PM2 (production)

From the repo root (after `npm install`, `.env` present):

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

Typical apps:

| Name | Script | Role |
|------|--------|------|
| `ig-dm-dashboard` | `server.js` | API + UI; Start/Stop toggles Supabase pause; scales `ig-dm-send` when configured |
| `ig-dm-send` | `workers/send-worker.js` | Cluster (`-i N`): claims send jobs, one pinned campaign slot per instance when `NODE_APP_INSTANCE` is set (see `.env.example`) |
| `ig-dm-scrape` | `workers/scrape-worker.js` | Optional scrape queue |

Restart after deploy:

```bash
git pull && npm install && pm2 restart ecosystem.config.cjs
# or by name:
pm2 restart ig-dm-dashboard ig-dm-send ig-dm-scrape
```

Logs:

```bash
./scripts/pm2-logs.sh send 100
./scripts/pm2-logs.sh dashboard 80
./scripts/pm2-logs.sh help
```

(`chmod +x scripts/pm2-logs.sh` once if needed.)

Send cluster size is driven by env (`SEND_WORKER_INSTANCES`, `SEND_WORKER_MIN` / `SEND_WORKER_MAX`, `SCALE_SEND_WORKERS_AUTO`) — see `.env.example`.

## Environment

```bash
cp .env.example .env
```

Set Supabase URL/key, `HEADLESS_MODE`, proxy/session vars as needed. Do not commit `.env`.

## Requirements

- Node.js 18+ (20 recommended)
- Linux server deps for Chromium (Puppeteer) — e.g. `libgbm1`, `libnss3`, `libatk1.0-0`, … (install what `puppeteer` / your distro docs recommend)

## Legacy CSV mode

If Supabase is **not** configured and `leads.csv` exists, `node cli.js --start` uses the older SQLite/CSV path (single-tenant). Supabase mode is the main product path.

## Headed / VNC debugging (optional)

Set `HEADLESS_MODE=false`, run Xvfb (e.g. `DISPLAY=:99`), point Puppeteer at that display, optionally run `x11vnc` and SSH-tunnel to watch the browser. Use `PUPPETEER_SLOW_MO_MS` to slow actions.

## DM search / login debug screenshots (VPS)

Logs print paths like `logs/login-debug/1776338959233_dm_search_before_pick_rossmann.png` (repo root on the server, e.g. `~/ColdDMs/`).

**View on your Mac** (replace host and path):

```bash
scp 'root@YOUR_DROPLET_IP:/root/ColdDMs/logs/login-debug/1776338959233_dm_search_before_pick_rossmann.png' ~/Downloads/
open ~/Downloads/1776338959233_dm_search_before_pick_rossmann.png
```

Or from the repo on the server: `cd ~/ColdDMs && python3 -m http.server 8080` then browse `http://YOUR_IP:8080/logs/login-debug/` (open port 8080 in the firewall if needed).

## Admin lab

Experimental routes live under `admin_lab/http.js` (`/api/admin-lab/*`). Require API key + `X-Admin-Lab-Secret` (`ADMIN_LAB_SECRET`).

## License

ISC
