# Deploying Kim's Marbles to your VPS

Written for your workflow: web terminal, one command at a time, short lines.
Replace `kimsmarbles.app` with your real domain everywhere.

**Read this first:** the preview link on claude.ai can never talk to your API
(published pages block requests to other sites). The frontend file has to be
served from *your* domain. Steps 8–9 do that, and it's the same nginx that
serves the API, so there's no CORS setup.

---

## 0. Accounts and DNS (do these first)

- New Supabase project (NOT `xlrcibziouffgxciecvc`, that's SeeWhy's production DB).
  Project Settings → Database → copy the **Session pooler** connection string
  (port 5432). Use the pooler, not the "Direct connection": new Supabase
  projects are IPv6-only on direct, and your VPS may not have IPv6.
- Stripe: test-mode secret key, and Connect enabled on the account.
- DNS: A record `kimsmarbles.app` → `2.24.198.112`.

## 1. Server prep

```bash
apt update
apt install -y python3 build-essential postgresql-client nginx certbot python3-certbot-nginx
node -v
```
Node must be 18 or newer. `python3` and `build-essential` are needed because
`mediasoup` compiles a native worker on install.

## 2. Get the code

Push this folder to a new GitHub repo first, then:

```bash
cd /opt
git clone <your-repo-url> kims-marbles
```

## 3. Install dependencies (slow — mediasoup compiles)

```bash
cd /opt/kims-marbles/server
nohup npm install --omit=dev > /tmp/km-install.log 2>&1 &
```
```bash
tail -5 /tmp/km-install.log
```
Repeat the `tail` until you see `added ... packages`. It can take several minutes.

## 4. Database

```bash
export SUPABASE_DB_URL='postgres://...your pooler string...'
psql "$SUPABASE_DB_URL" -f /opt/kims-marbles/schema.sql
psql "$SUPABASE_DB_URL" -f /opt/kims-marbles/rls.sql
```
Optional sample data (dev only, all passwords are `password123`, skip on a real launch):
```bash
psql "$SUPABASE_DB_URL" -f /opt/kims-marbles/seed.sql
```

> **Upgrading an existing database?** Refresh tokens are now stored server-side.
> `schema.sql` creates the table for new installs; on an existing database run:
> ```sql
> create table refresh_tokens (
>   id uuid primary key default uuid_generate_v4(),
>   user_id uuid not null references users(id) on delete cascade,
>   family_id uuid not null,
>   token_hash text unique not null,
>   created_at timestamptz default now(),
>   expires_at timestamptz not null,
>   revoked_at timestamptz,
>   revoked_reason text
> );
> create index idx_refresh_tokens_user on refresh_tokens(user_id);
> create index idx_refresh_tokens_family on refresh_tokens(family_id);
> alter table refresh_tokens enable row level security;
> ```
> Refresh tokens issued before this change have no stored record, so each user is
> asked to log in once more after you deploy it.

> **Upgrading an existing database again?** Live-chat moderation adds one table
> (`schema.sql` creates it for new installs):
> ```sql
> create table moderation_settings (
>   user_id uuid primary key references users(id) on delete cascade,
>   enabled boolean not null default false,
>   words text[] not null default '{}',
>   updated_at timestamptz default now()
> );
> alter table moderation_settings enable row level security;
> create policy moderation_own on moderation_settings
>   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
> ```

> **Upgrading an existing database a third time?** The dashboard adds three tables
> (`schema.sql` creates them for new installs):
> ```sql
> create table activity_events (
>   seq bigserial primary key,
>   user_id uuid not null references users(id) on delete cascade,
>   kind text not null, text text not null, ref_id uuid,
>   created_at timestamptz default now()
> );
> create index idx_activity_user_seq on activity_events(user_id, seq desc);
> create table game_scores (
>   user_id uuid not null references users(id) on delete cascade,
>   game text not null check (game in ('trivia', 'speed')),
>   best integer not null default 0, plays integer not null default 0,
>   updated_at timestamptz default now(), primary key (user_id, game)
> );
> create table listing_templates (
>   id uuid primary key default uuid_generate_v4(),
>   user_id uuid not null references users(id) on delete cascade,
>   name text not null, category text not null,
>   grade text not null check (grade in ('mint', 'near-mint', 'good')),
>   type text not null check (type in ('sale', 'trade', 'auction')),
>   price_cents integer not null default 0, description text not null default '',
>   created_at timestamptz default now(), updated_at timestamptz default now()
> );
> create unique index uq_listing_templates_user_name on listing_templates(user_id, lower(name));
> alter table activity_events enable row level security;
> create policy activity_select_own on activity_events for select using (user_id = auth.uid());
> alter table game_scores enable row level security;
> create policy game_scores_select_own on game_scores for select using (user_id = auth.uid());
> alter table listing_templates enable row level security;
> create policy listing_templates_own on listing_templates
>   for all using (user_id = auth.uid()) with check (user_id = auth.uid());
> ```

## 5. Environment file

```bash
cd /opt/kims-marbles/server
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
curl -s ifconfig.me
nano .env
```
Fill in: `SUPABASE_DB_URL`, the two random strings as `JWT_SECRET` and
`JWT_REFRESH_SECRET` (different values), `MEDIASOUP_ANNOUNCED_IP` (the IP
`ifconfig.me` printed), `APP_URL=https://kimsmarbles.app`, and your Stripe
test key. Leave `STRIPE_WEBHOOK_SECRET` for step 10.

## 6. Open the video ports

Media goes through **one port per mediasoup worker**, UDP and TCP together:
worker *i* listens on `MEDIASOUP_PORT + i` (default **44444**, and 44445 with the
default 2 workers). That is a handful of ports, not a range.

```bash
ufw allow 80,443/tcp
ufw allow 44444:44445/udp
ufw allow 44444:44445/tcp
ufw status
```
If you set `MEDIASOUP_WORKERS=4`, open `44444:44447`; if you change
`MEDIASOUP_PORT`, open that instead. Also check Hostinger's own firewall panel
for the VPS — a provider-level firewall blocks traffic even when `ufw` allows it.

After starting the server, confirm it is listening (two workers shown):
```bash
ss -lunp | grep 4444      # UDP
ss -ltnp | grep 4444      # TCP
```
The server logs `WebRTC on ports 44444-44445 (udp+tcp), announced as <your IP>`
at startup, and **refuses to start** if `MEDIASOUP_ANNOUNCED_IP` is missing in
production or the port is already in use — rather than running with no video.

Guests whose network blocks UDP fall back to TCP on the same port. A network
that blocks *both* (some corporate firewalls allow only 443) can't reach the
media server; that needs a TURN server, which is **not** set up here.

## 6.5 Redis (only if you run more than one PM2 instance)

A single PM2 process doesn't need this — skip to step 7. If you ever run
`pm2 start index.js -i 2` (or more) for load, each process has its own memory,
so a phone connected to process A and a desktop connected to process B won't
see each other's real-time updates at all without a shared pub/sub layer.

```bash
apt install -y redis-server
systemctl enable --now redis-server
redis-cli ping
```
Expect `PONG`. Then in `.env`, uncomment and set:
```
REDIS_URL=redis://localhost:6379
```
Restart the server after adding this — `pm2 restart kims-marbles-server --update-env`.
Logs should show `[socket.io] Redis adapter connected — multi-instance sync enabled`.

## 6.7 TURN relay (strongly recommended before real users)

Without a relay, anyone behind a strict home/corporate NAT or a network that blocks UDP
cannot join a stream at all. coturn fixes that. Run it on the VPS (or a second one — it
relays media, so it uses real bandwidth).

```bash
apt install -y coturn
cp /opt/kims-marbles/deploy/turnserver.conf /etc/turnserver.conf
# edit: external-ip, realm/server-name, static-auth-secret (openssl rand -hex 32), cert paths
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable --now coturn
```
Open the firewall (and the Hostinger panel): `3478` udp+tcp, `5349` tcp (+udp), and the relay
range `50000-50999` udp. Then in the backend `.env` (same secret as `static-auth-secret`):
```
TURN_URLS=turn:turn.yourdomain.com:3478?transport=udp,turn:turn.yourdomain.com:3478?transport=tcp,turns:turn.yourdomain.com:5349?transport=tcp
TURN_SECRET=<the same secret>
```
`pm2 restart kims-marbles-server --update-env`. The app fetches short-lived credentials from
`GET /api/rtc/ice-servers` (login required; nothing secret is ever sent to the browser).

**Check it works** from a browser console on the live site:
`localStorage.kmIceTransportPolicy='relay'`, reload, join a stream. That forces relay-only media;
if video flows, TURN is working (remove the key afterwards). Locally, the same check is automated
in `frontend/e2e-browser/turn.test.mjs` against a real coturn with `deploy/turnserver.test.conf`.

**Security:** keep the `denied-peer-ip` lines in `turnserver.conf` — they stop the relay being
used to reach your private network. Never use `allow-loopback-peers` outside local tests.
`turns:` on 443 (for networks that only allow HTTPS) needs coturn on its own IP or a TLS-SNI
proxy; 5349 is enough for most networks.

## 7. Start the server

```bash
cd /opt/kims-marbles/server
pm2 start index.js --name kims-marbles-server
pm2 save
pm2 logs kims-marbles-server --lines 30
```
Healthy output includes `[mediasoup] 2 worker(s) ready` and
`listening on :4100`. A Stripe key warning is fine until you add the key.

**If you change `.env` later:** PM2 caches the old environment. Use
`pm2 restart kims-marbles-server --update-env`, and if a value still looks
stale, `pm2 delete kims-marbles-server` then start it again. (Same stale-env
trap as the SeeWhy 500s.)

## 8. Put the frontend on your domain

Use the **React app** (`kims-marbles-frontend/`). It is the one with real
routing, so invite links (`/join/<token>`) and page refreshes work; nginx's
`try_files $uri /index.html` in step 9 is what serves those deep links.

Build it with Node 20+ (on your laptop or the VPS):

```bash
cd kims-marbles-frontend
npm install
VITE_API_URL= npm run build        # EMPTY value = same origin (app and API on one domain)
mkdir -p /var/www/kims-marbles
rsync -a --delete dist/ /var/www/kims-marbles/
```
`VITE_API_URL=` (nothing after the `=`) is deliberate: the app then calls
`/api/...` on whatever domain served it, so there is no CORS to configure.
Without it the app falls back to `http://localhost:4100` and will try to reach
the *visitor's own machine*. Check with:
```bash
grep -c "localhost:4100" /var/www/kims-marbles/assets/*.js   # every file should print 0
```
If the API lives on a different domain, build with
`VITE_API_URL=https://api.yourdomain.com` instead (and tighten CORS in `app.js`).

> The single-file `frontend/index.html` preview still works for a quick look,
> but it has no router (invite links won't open) and it never refreshes an
> expired login — use the React build for anything real.

## 9. nginx + HTTPS

```bash
cp /opt/kims-marbles/deploy/nginx.conf /etc/nginx/sites-available/kims-marbles
nano /etc/nginx/sites-available/kims-marbles
```
Change `server_name` to your domain, save, then:
```bash
ln -s /etc/nginx/sites-available/kims-marbles /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
certbot --nginx -d kimsmarbles.app
```
The config includes the WebSocket upgrade block for `/socket.io/`. Without it
live chat, reactions and watch party fall back to slow polling.

## 10. Stripe webhook

Stripe Dashboard → Developers → Webhooks → add endpoint
`https://kimsmarbles.app/api/payments/webhook`, events
`checkout.session.completed` and `checkout.session.expired`. Copy the signing
secret (`whsec_...`) into `.env` as `STRIPE_WEBHOOK_SECRET`, then:
```bash
pm2 restart kims-marbles-server --update-env
```

## 11. Verify

```bash
curl -s https://kimsmarbles.app/health
```
Expect `{"ok":true,"service":"kims-marbles-server"}`. Then open the site on
your phone, create an account, list a marble, post to the feed. Check the
server side:
```bash
pm2 logs kims-marbles-server --lines 20
```
Each request shows as a line with a status code and timing.

## 12. Make yourself an admin (for the moderation queue)

```bash
psql "$SUPABASE_DB_URL" -c "update users set is_admin = true where handle = 'YourHandle';"
```

---

## Before you invite real users

- **Attorney review and Stripe test → live** are still your launch blockers.
  Nothing here changes that. Switch to live keys only after both clear.
- CORS is currently open (`*`). Same-origin hosting doesn't need it, so once
  you're live, tighten `cors()` in `server/app.js` to your domain.
- Rate limiting is per-process memory. Fine for one PM2 process; move to a
  Redis store before running more.
- mediasoup **video tiles**: the server is ready, but the frontend still uses
  plain `getUserMedia` locally. Swapping to the SFU means bundling
  `client-reference/mediaClient.js` into a real Vite/React frontend.
- Guests on locked-down corporate networks may need a TURN relay. Skip until
  someone reports it.
- Back up the Supabase project (it has daily backups on paid plans).
