#!/usr/bin/env bash
# Tail PM2 logs for Cold DM apps. Run from anywhere (uses pm2 in PATH).
set -euo pipefail

LINES="${2:-100}"

usage() {
  cat <<'EOF'
Usage: pm2-logs.sh <target> [lines]

  send        ig-dm-send (Cold DM send worker)
  dashboard   ig-dm-dashboard (API + UI)
  scrape      ig-dm-scrape (scrape worker)
  all         all PM2 processes

Examples:
  ./scripts/pm2-logs.sh send
  ./scripts/pm2-logs.sh send 200
  ./scripts/pm2-logs.sh dashboard 80

Other (run manually on VPS):
  git pull && npm install && pm2 restart ecosystem.config.cjs
  git pull && npm install && pm2 restart ig-dm-dashboard

VNC / headed browser: README.md → "Headed / VNC debugging"
  ssh -L 5900:127.0.0.1:5900 root@YOUR_IP
  # .env: HEADLESS_MODE=false DISPLAY=:99 PUPPETEER_SLOW_MO_MS=80

Debug env (set in .env, then restart the relevant app):
  SCRAPER_DEBUG=1 SCRAPER_FAILURE_SCREENSHOT=1
  LOGIN_DEBUG_SCREENSHOTS=1 DM_SEARCH_DEBUG_SCREENSHOTS=1
EOF
}

case "${1:-}" in
  send) exec pm2 logs ig-dm-send --lines "$LINES" ;;
  dashboard | dash) exec pm2 logs ig-dm-dashboard --lines "$LINES" ;;
  scrape) exec pm2 logs ig-dm-scrape --lines "$LINES" ;;
  all) exec pm2 logs --lines "$LINES" ;;
  help | --help | -h | '') usage ;;
  *)
    echo "Unknown target: ${1:-}" >&2
    usage >&2
    exit 1
    ;;
esac
