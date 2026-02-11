# Instagram Cold DM Bot

Node.js bot that sends cold DMs from a CSV lead list using Puppeteer, with random delays, daily/hourly limits, and SQLite tracking.

**Integrating as a Cold Outreach tab in your setter (Lovable)?** See **[INTEGRATION.md](./INTEGRATION.md)** for Supabase schema, session-only Instagram (no password stored), and how the Lovable UI and VPS stay in sync. Use **[PROMPT_LOVABLE.md](./PROMPT_LOVABLE.md)** as the prompt to paste in the setter Cursor project.

## Requirements

- Node.js v18+ (v20 recommended)
- A test Instagram account (do not use your main account)

## Quick start (local)

1. **Install dependencies**

   ```bash
   npm install
   ```

   (First run may take a few minutes while Puppeteer downloads Chromium.)

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set:

   - `INSTAGRAM_USERNAME` and `INSTAGRAM_PASSWORD`
   - Optionally adjust `DAILY_SEND_LIMIT`, `MIN_DELAY_MINUTES`, `MAX_DELAY_MINUTES`, `HEADLESS_MODE`

3. **Add leads**

   Copy the example and add usernames (one per line, with a header `username`):

   ```bash
   cp leads.csv.example leads.csv
   ```

   Edit `leads.csv`. You can use a column named `username`, `Username`, `user`, or `User`; with or without `@`.

4. **Run the bot**

   ```bash
   npm start
   # or
   node cli.js --start
   ```

   To see status without starting:

   ```bash
   node cli.js --status
   ```

   To reset today’s send counter (admin):

   ```bash
   node cli.js --reset-daily
   ```

5. **Web dashboard (optional)**

   Add Instagram credentials and leads from the browser:

   ```bash
   npm run dashboard
   ```

   Open **http://localhost:3000**. Use **Settings** for Instagram username/password and limits; **Leads** to paste or upload usernames. Start the bot with `npm start` when ready.

## Project layout

- `bot.js` – Login, send DM, load CSV, scheduling and safety logic
- `cli.js` – Entry point: `--start`, `--status`, `--reset-daily`
- `config/messages.js` – Message templates (edit to add/change lines)
- `database/db.js` – SQLite helpers and schema
- `utils/logger.js` – Logging to console and `logs/bot.log`
- `leads.csv` – Your lead list (create from `leads.csv.example`)
- `server.js` – Web dashboard (Express); run with `npm run dashboard`
- `public/index.html` – Dashboard UI

## Safety

- Daily send limit (default 100) and hourly cap (default 20)
- Random delay between sends (default 5–30 minutes)
- Skips users already in `sent_messages`
- Stealth plugin to reduce automation detection
- Use a test account and small lists first

## Deployment (VPS, 24/7)

Run the same app on a small Linux server so it can run 24/7.

1. **Server**
   - Provider: DigitalOcean, Linode, Vultr, etc.
   - Image: Ubuntu 22.04 LTS
   - Size: 1 vCPU, 1–2 GB RAM

2. **On the server**
   - Update: `sudo apt update && sudo apt upgrade -y`
   - Install Node 20:  
     `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -`  
     `sudo apt install -y nodejs`
   - Chromium deps for Puppeteer:  
     `sudo apt install -y libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2`

3. **Get the project**
   - Clone: `git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git && cd YOUR_REPO`
   - Or copy via SCP from your Mac, then `npm install`

4. **Configure**
   - Create `.env` (same as local), set `HEADLESS_MODE=true`
   - Add `leads.csv` (or set `LEADS_CSV` in `.env`)

5. **Run with PM2**
   - `npm install -g pm2`
   - `pm2 start cli.js --name ig-dm-bot -- --start`
   - `pm2 save`
   - `pm2 startup` and run the command it prints

   Then: `pm2 status`, `pm2 logs ig-dm-bot`, `pm2 restart ig-dm-bot`.

The bot only makes **outbound** connections to Instagram; you don’t need to open inbound ports for it. For a future web dashboard you’d open port 80/443 and use Nginx.

## Git and GitHub (easy uploads)

1. **Initialize and push**
   - Create a new repo on GitHub (empty, no README).
   - In the project folder:
     ```bash
     git init
     git add .
     git commit -m "Initial commit"
     git branch -M main
     git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
     git push -u origin main
     ```

2. **On the VPS**
   - First time: `git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git && cd YOUR_REPO_NAME && npm install`
   - After you push updates: `cd YOUR_REPO_NAME && git pull && pm2 restart ig-dm-bot`

Do **not** commit `.env` or `leads.csv` (they’re in `.gitignore`). Keep those only on your machine and on the server.

## Troubleshooting

- **Login fails:** Check username/password in `.env`. Use a test account. If Instagram shows “suspicious activity”, solve the challenge in a normal browser first, then try again.
- **“Leads file not found”:** Create `leads.csv` from `leads.csv.example` in the project root, or set `LEADS_CSV` in `.env`.
- **Selectors break:** Instagram changes their HTML. If send DM fails, inspect the DM flow in the browser and update selectors in `bot.js` (e.g. `input[name="queryBox"]`, `textarea`, buttons).
- **Puppeteer on Linux:** If launch fails, install the Chromium deps listed in Deployment.

## License

ISC
