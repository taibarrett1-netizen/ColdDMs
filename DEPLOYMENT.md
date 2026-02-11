# Deployment (VPS, 24/7)

Run the bot on a small Linux server so it can run 24/7. Same steps as in the README; consolidated here for reference.

## 1. Choose a server

- **Provider:** DigitalOcean, Linode, Vultr, etc. (e.g. DigitalOcean "Basic" $6/mo)
- **Image:** Ubuntu 22.04 LTS
- **Size:** 1 vCPU, 1–2 GB RAM
- **Region:** Any (latency to Instagram is fine from any region)

## 2. First login and basics

- SSH: `ssh root@YOUR_SERVER_IP` (or `ubuntu@...` if your provider gives an `ubuntu` user)
- Update: `sudo apt update && sudo apt upgrade -y`

## 3. Install Node.js (v20+)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

## 4. Install Chromium dependencies (for Puppeteer)

Puppeteer needs these on minimal Linux for headless Chrome:

```bash
sudo apt install -y libgbm1 libasound2 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2
```

## 5. Get the project onto the server

**Option A – Git**

```bash
cd ~
git clone https://github.com/taibarrett1-netizen/ColdDMs.git
cd ColdDMs
npm install
```

**Option B – SCP from your Mac**

```bash
# On your Mac:
scp -r "/path/to/Cold DMs V1" user@SERVER_IP:~/cold-dm-bot

# On server:
cd ~/cold-dm-bot
npm install
```

No inbound firewall ports are needed for the bot; it only makes outbound connections to Instagram.

## 6. Configure on the server

- Create `.env` (same variables as local). Set `HEADLESS_MODE=true`.
- Add `leads.csv` in the project folder (or set `LEADS_CSV` in `.env`).
- The SQLite DB at `database/bot.db` is created on first run; ensure the `database/` directory is writable.

## 7. Run with PM2

```bash
npm install -g pm2
pm2 start cli.js --name ig-dm-bot -- --start
pm2 save
pm2 startup
# Run the command that pm2 startup prints (so the bot restarts on reboot)
```

**Useful commands**

- `pm2 status` – list processes
- `pm2 logs ig-dm-bot` – view logs
- `pm2 restart ig-dm-bot` – restart after code/config changes

## 8. Web dashboard (optional)

Run the dashboard on the same server so you can add leads and edit settings in the browser:

```bash
cd ~/ColdDMs
npm run dashboard
# Or with PM2: pm2 start server.js --name ig-dm-dashboard
```

Then open **http://YOUR_DROPLET_IP:3000**. To expose it on port 80 (optional), use Nginx as a reverse proxy to `http://127.0.0.1:3000`.

## 9. Updating after you push to GitHub

On the VPS:

```bash
cd YOUR_REPO
git pull
npm install   # if package.json changed
pm2 restart ig-dm-bot
```
