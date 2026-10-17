#!/bin/bash
# One-time setup of a FRESH Ubuntu 24.04 VPS for Kim's Marbles at vibenbones.online.
# Safe to re-run: every step checks before it changes anything, and secrets are generated
# only once (kept in server/.env).
#
#   git clone https://github.com/SwanyThree23/Marbles.git /opt/kims-marbles
#   CERTBOT_EMAIL=you@example.com bash /opt/kims-marbles/kims-marbles-backend/deploy/setup-vps.sh
#
# Before running: DNS A records for vibenbones.online, www and turn must point at this VPS.
set -euo pipefail

DOMAIN=vibenbones.online
SEEWHY_VPS_IP=2.24.194.112                 # SeeWhy LIVE's server: never deploy there
APP_DIR=/opt/kims-marbles
BACKEND=$APP_DIR/kims-marbles-backend
SERVER=$BACKEND/server
FRONTEND=$APP_DIR/kims-marbles-frontend
WEB_ROOT=/var/www/kims-marbles
APP_USER=kims
DB_NAME=kims_marbles
ENV_FILE=$SERVER/.env
MS_PORT=44444
MS_WORKERS=2

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }
secret() { openssl rand -hex 32; }
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# ---------------------------------------------------------------- checks
step "Checks"
[ "$(id -u)" -eq 0 ] || die "run as root"
grep -q 'VERSION_ID="24.04"' /etc/os-release || die "this script is written for Ubuntu 24.04"
[ -d "$SERVER" ] || die "clone the repo to $APP_DIR first (see the top of this file)"
: "${CERTBOT_EMAIL:?set CERTBOT_EMAIL=you@example.com (certificate expiry notices)}"
command -v curl >/dev/null || apt-get install -y -q curl
PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org) || die "cannot find this server's public IPv4"
echo "public IPv4: $PUBLIC_IP"
[ "$PUBLIC_IP" != "$SEEWHY_VPS_IP" ] || die "this is SeeWhy LIVE's VPS. Kim's Marbles must run on its own server."
for host in "$DOMAIN" "www.$DOMAIN" "turn.$DOMAIN"; do
  got=$(getent ahostsv4 "$host" | awk 'NR==1{print $1}')
  [ "$got" = "$PUBLIC_IP" ] || die "DNS: $host points at '${got:-nothing}', not $PUBLIC_IP. Fix the A record, wait a few minutes, re-run."
done
echo "DNS ok for $DOMAIN, www.$DOMAIN, turn.$DOMAIN"

# ---------------------------------------------------------------- packages
step "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx certbot postgresql coturn ufw git rsync build-essential python3 python3-pip ca-certificates openssl cron
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2@5
node -v

# ---------------------------------------------------------------- user, dirs
step "App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /bin/bash "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" /var/log/kims-marbles /var/backups/kims-marbles
install -d "$WEB_ROOT" /var/www/certbot
git config --global --add safe.directory "$APP_DIR"

# ---------------------------------------------------------------- database
step "Database (Postgres on this server)"
systemctl enable --now postgresql
DB_PASS=""
if [ -f "$ENV_FILE" ]; then DB_PASS=$(env_get DATABASE_URL | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#'); fi
[ -n "$DB_PASS" ] || DB_PASS=$(secret)
if ! sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = '$APP_USER'" | grep -q 1; then
  sudo -u postgres psql -q -c "create role $APP_USER login password '$DB_PASS'"
fi
if ! sudo -u postgres psql -tAc "select 1 from pg_database where datname = '$DB_NAME'" | grep -q 1; then
  sudo -u postgres createdb -O "$APP_USER" "$DB_NAME"
fi
# the auth stub (dev/local-auth-stub.sql, applied by the migration) creates a schema and a role
sudo -u postgres psql -q -d "$DB_NAME" -c "grant create on database $DB_NAME to $APP_USER" >/dev/null
sudo -u postgres psql -q -c "alter role $APP_USER createrole" >/dev/null

# ---------------------------------------------------------------- .env
step "Server settings (.env)"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=4100
APP_URL=https://$DOMAIN
DATABASE_URL=postgres://$APP_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
PG_POOL_MAX=10
JWT_SECRET=$(secret)
MEDIASOUP_ANNOUNCED_IP=$PUBLIC_IP
MEDIASOUP_PORT=$MS_PORT
MEDIASOUP_WORKERS=$MS_WORKERS
TURN_URLS=turn:turn.$DOMAIN:3478?transport=udp,turn:turn.$DOMAIN:3478?transport=tcp,turns:turn.$DOMAIN:5349?transport=tcp
TURN_SECRET=$(secret)
STUN_URLS=stun:turn.$DOMAIN:3478
METRICS_TOKEN=$(secret)
HOST_GRACE_MS=120000
# Stripe TEST keys (sk_test_..., whsec_...). Live keys are refused.
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
EOF
  echo "wrote $ENV_FILE with new secrets"
else
  echo "$ENV_FILE exists: keeping it"
  [ "$(env_get MEDIASOUP_ANNOUNCED_IP)" = "$PUBLIC_IP" ] || echo "WARNING: MEDIASOUP_ANNOUNCED_IP in .env is not $PUBLIC_IP"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- build
step "Install, migrate, build"
sudo -u "$APP_USER" bash -c "cd '$SERVER' && npm ci --omit=dev --no-audit --no-fund"
sudo -u "$APP_USER" bash -c "cd '$SERVER' && node --env-file=.env scripts/migrate.js"
sudo -u "$APP_USER" bash -c "cd '$FRONTEND' && npm ci --no-audit --no-fund && VITE_API_URL= npm run build"
if grep -q "localhost:4100" "$FRONTEND"/dist/assets/*.js; then die "the frontend build calls localhost:4100"; fi
rsync -a --delete "$FRONTEND/dist/" "$WEB_ROOT/"

# ---------------------------------------------------------------- https
step "nginx and the HTTPS certificate"
rm -f /etc/nginx/sites-enabled/default
install -m 644 "$BACKEND/deploy/nginx/kims-marbles-app.conf" /etc/nginx/snippets/kims-marbles-app.conf
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
install_site() {
  install -m 644 "$1" /etc/nginx/sites-available/kims-marbles
  # a VPS without IPv6 cannot open [::] listeners
  [ -s /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' /etc/nginx/sites-available/kims-marbles
  ln -sf /etc/nginx/sites-available/kims-marbles /etc/nginx/sites-enabled/kims-marbles
  nginx -t
  systemctl enable nginx >/dev/null 2>&1
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
}
install -d /etc/letsencrypt/renewal-hooks/deploy
install -m 755 "$BACKEND/deploy/certbot-deploy-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/kims-marbles.sh
if [ ! -f "$CERT" ]; then
  install_site "$BACKEND/deploy/nginx/bootstrap.conf"
  ufw allow 80/tcp >/dev/null
  certbot certonly --webroot -w /var/www/certbot --non-interactive --agree-tos -m "$CERTBOT_EMAIL" \
    -d "$DOMAIN" -d "www.$DOMAIN" -d "turn.$DOMAIN"
fi
bash /etc/letsencrypt/renewal-hooks/deploy/kims-marbles.sh   # copies the cert for coturn
install_site "$BACKEND/deploy/nginx/kims-marbles.conf"

# ---------------------------------------------------------------- turn
step "TURN relay (coturn)"
TURN_SECRET=$(env_get TURN_SECRET)
[ -n "$TURN_SECRET" ] || die "TURN_SECRET missing from $ENV_FILE"
sed -e "s/__PUBLIC_IP__/$PUBLIC_IP/" -e "s/__TURN_SECRET__/$TURN_SECRET/" "$BACKEND/deploy/turnserver.conf" > /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn

# ---------------------------------------------------------------- firewall
step "Firewall (ufw)"
LAST_MS=$((MS_PORT + MS_WORKERS - 1))
ufw allow OpenSSH >/dev/null
ufw allow 80,443/tcp >/dev/null
ufw allow "$MS_PORT:$LAST_MS/udp" >/dev/null
ufw allow "$MS_PORT:$LAST_MS/tcp" >/dev/null
ufw allow 3478 >/dev/null
ufw allow 5349 >/dev/null
ufw allow 50000:50999/udp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,40p'

# ---------------------------------------------------------------- run
step "Start the server (PM2, as $APP_USER)"
sudo -u "$APP_USER" bash -c "pm2 startOrReload '$BACKEND/deploy/ecosystem.config.cjs' && pm2 save"
env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
sudo -u "$APP_USER" bash -c "pm2 install pm2-logrotate >/dev/null 2>&1 || true"

step "Nightly database backup"
cat > /etc/cron.d/kims-marbles-backup <<EOF
15 3 * * * $APP_USER $BACKEND/deploy/backup.sh >> /var/log/kims-marbles/backup.log 2>&1
EOF
chmod 644 /etc/cron.d/kims-marbles-backup
sudo -u "$APP_USER" "$BACKEND/deploy/backup.sh"

step "Smoke test"
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:4100/health >/dev/null 2>&1 && break; sleep 1; done
sudo -u "$APP_USER" bash -c "cd '$SERVER' && node scripts/smoke.js https://$DOMAIN"

cat <<EOF

Kim's Marbles is running at https://$DOMAIN

Still to do by hand:
  1. Hostinger panel -> VPS -> Firewall: allow the same ports as ufw above
     (80, 443 tcp; $MS_PORT-$LAST_MS udp+tcp; 3478 udp+tcp; 5349; 50000-50999 udp),
     or remove the panel firewall. A panel firewall blocks video even when ufw allows it.
  2. Stripe (TEST mode): put sk_test_... in STRIPE_SECRET_KEY in $ENV_FILE, add the webhook
     https://$DOMAIN/api/payments/webhook (checkout.session.completed, checkout.session.expired)
     and put its whsec_... in STRIPE_WEBHOOK_SECRET. Then: sudo -u $APP_USER pm2 restart kims-marbles
EOF
