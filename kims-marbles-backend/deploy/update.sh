#!/bin/bash
# Deploy the latest code to an already set-up VPS (after setup-vps.sh). Run as root:
#   bash /opt/kims-marbles/kims-marbles-backend/deploy/update.sh [branch]
# Stops before touching the live site if the build or a migration fails.
set -euo pipefail
APP_DIR=/opt/kims-marbles
BRANCH=${1:-$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)}
SERVER=$APP_DIR/kims-marbles-backend/server
FRONTEND=$APP_DIR/kims-marbles-frontend
APP_USER=kims

sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" checkout -q "$BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
echo "code: $(git -C "$APP_DIR" log --oneline -1)"

sudo -u "$APP_USER" bash -c "cd '$SERVER' && npm ci --omit=dev --no-audit --no-fund"
sudo -u "$APP_USER" bash -c "cd '$FRONTEND' && npm ci --no-audit --no-fund && VITE_API_URL= npm run build"
if grep -q "localhost:4100" "$FRONTEND"/dist/assets/*.js; then echo "STOP: the build calls localhost:4100" >&2; exit 1; fi

sudo -u "$APP_USER" "$APP_DIR/kims-marbles-backend/deploy/backup.sh"           # before any migration
sudo -u "$APP_USER" bash -c "cd '$SERVER' && node --env-file=.env scripts/migrate.js"

install -m 644 "$APP_DIR/kims-marbles-backend/deploy/nginx/kims-marbles-app.conf" /etc/nginx/snippets/kims-marbles-app.conf
nginx -t && systemctl reload nginx
rsync -a --delete "$FRONTEND/dist/" /var/www/kims-marbles/
# a restart ends live streams for a moment; viewers' apps reconnect by themselves
sudo -u "$APP_USER" pm2 reload kims-marbles
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:4100/health >/dev/null 2>&1 && break; sleep 1; done
sudo -u "$APP_USER" bash -c "cd '$SERVER' && node scripts/smoke.js https://vibenbones.online"
