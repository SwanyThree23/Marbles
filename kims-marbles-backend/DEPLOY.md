# Deploying Kim's Marbles to vibenbones.online

Kim's Marbles gets **its own VPS**. It never shares a server, database or keys with
SeeWhy LIVE. The setup script refuses to run on SeeWhy's VPS (`2.24.194.112`), and the
server refuses SeeWhy's Supabase project.

Everything runs on that one VPS:

| Piece | What it does |
|---|---|
| nginx | HTTPS, serves the app, forwards `/api` and the live socket to the server |
| Node server (PM2) | API, real-time, media server (mediasoup) |
| Postgres | the database (nightly backups, 14 days kept) |
| coturn | TURN relay, so viewers on strict networks still get video |

Written for a web terminal: one command at a time.

---

## 1. Buy the VPS

Hostinger **KVM 2 or bigger**, **Ubuntu 24.04**. Note its IPv4 address.

KVM 2 has 2 vCPU and 8 GB. That fits many live rooms at once. What runs out first is
**video**, because every viewer receives every person on stage. A 6-person panel with
50 viewers is about 300 video streams going out. Watch the `/metrics` numbers once
you're live (step 9).

## 2. DNS (at your domain registrar)

Make three **A records**, all pointing at the new VPS IP:

| Name | Type | Value |
|---|---|---|
| `@` | A | *new VPS IP* |
| `www` | A | *new VPS IP* |
| `turn` | A | *new VPS IP* |

Delete any old A/AAAA records for these names (for example "parked" records).
Wait 5–30 minutes, then check from any computer:
```bash
nslookup vibenbones.online
```

## 3. Log in to the VPS

Hostinger panel → VPS → **Browser terminal** (or `ssh root@<IP>`).

## 4. Get the code

```bash
apt-get update && apt-get install -y git
```
```bash
git clone -b claude/kims-marbles-finish-harden-6pmqhl https://github.com/SwanyThree23/Marbles.git /opt/kims-marbles
```
If the repo is private, GitHub asks for a username and a **personal access token**
(github.com → Settings → Developer settings → Fine-grained token, read-only on this repo).
Paste it at the password prompt. It is not stored.

## 5. Run the setup (about 10 minutes)

```bash
CERTBOT_EMAIL=you@example.com bash /opt/kims-marbles/kims-marbles-backend/deploy/setup-vps.sh
```
Use your real email; Let's Encrypt only uses it for certificate-expiry warnings.

The setup script:

- checks the DNS and that this is not SeeWhy's server
- installs everything
- creates the database
- writes `server/.env` with fresh random secrets, never shown on screen
- builds the app
- gets the HTTPS certificate
- sets up the TURN relay, the firewall, the server process and the nightly backup
- finishes with a **smoke test**: 10 checks ending in `all checks passed`

It is safe to run again. It keeps existing secrets and data.

If it stops with `STOP: ...`, the message says what to fix. The usual one is DNS that
hasn't updated yet. Wait and run the same command again.

## 6. Hostinger's own firewall

Hostinger panel → VPS → **Security → Firewall**. Either have no rules, or allow:

| Ports | Protocol | Why |
|---|---|---|
| 22 | TCP | SSH |
| 80, 443 | TCP | the website |
| 44444–44445 | UDP **and** TCP | live video |
| 3478 | UDP and TCP | TURN relay |
| 5349 | TCP | TURN over TLS |
| 50000–50999 | UDP | TURN relay ports |

A panel firewall blocks video even when the server's own firewall allows it.

## 7. Stripe (test mode only)

Stripe dashboard, in **Test mode**:

1. Developers → API keys → copy the **secret key** (`sk_test_...`).
2. Developers → Webhooks → **Add endpoint**:
   `https://vibenbones.online/api/payments/webhook`.
   Events: `checkout.session.completed`, `checkout.session.expired`.
   Copy the **signing secret** (`whsec_...`).
3. Connect must be enabled on the account (sellers and hosts get paid through it).

Put both in the server settings:
```bash
nano /opt/kims-marbles/kims-marbles-backend/server/.env
```
Fill `STRIPE_SECRET_KEY=` and `STRIPE_WEBHOOK_SECRET=`, save (Ctrl+O, Enter, Ctrl+X), then:
```bash
sudo -u kims pm2 restart kims-marbles
```
A live key (`sk_live_...`) is **refused**: the server won't start with one. That stays
true until the legal review is done and you deliberately set `STRIPE_ALLOW_LIVE=true`.

## 8. Try it

Open https://vibenbones.online on your phone and on a computer:

- create an account
- list a marble
- go live on one device and join from the other

## 9. Day to day

| Task | Command |
|---|---|
| Is it healthy? | `curl -s https://vibenbones.online/health` |
| Server log | `sudo -u kims pm2 logs kims-marbles --lines 50` |
| Restart | `sudo -u kims pm2 restart kims-marbles` |
| Numbers (memory, sockets, rooms, video streams) | see below |
| Deploy new code | `bash /opt/kims-marbles/kims-marbles-backend/deploy/update.sh` |
| Backups | `ls -lh /var/backups/kims-marbles` |

Numbers:
```bash
cd /opt/kims-marbles/kims-marbles-backend/server
curl -s -H "Authorization: Bearer $(grep ^METRICS_TOKEN= .env | cut -d= -f2)" http://127.0.0.1:4100/metrics | grep ^km_
```

`update.sh` does the following, and stops before anything changes if the build fails:

1. pulls the code and rebuilds
2. **backs up the database first**
3. runs database migrations
4. reloads the server
5. runs the smoke test

A reload interrupts live streams for a few seconds; viewers' apps reconnect on their own.

**Restore a backup** (replaces the current data):
```bash
sudo -u kims pg_restore --clean --if-exists --no-owner -d "$(grep ^DATABASE_URL= /opt/kims-marbles/kims-marbles-backend/server/.env | cut -d= -f2-)" /var/backups/kims-marbles/<file>.dump
```
Backups live on the same VPS. Copy one off the server now and then (Hostinger's own
VPS snapshots are a good second layer).

## 10. Make yourself an admin (moderation queue)

```bash
sudo -u kims psql "$(grep ^DATABASE_URL= /opt/kims-marbles/kims-marbles-backend/server/.env | cut -d= -f2-)" -c "update users set is_admin = true where handle = 'YourHandle';"
```

---

## Settings reference

All settings live in `server/.env`; every one is documented in `server/.env.example`.
The server checks them at startup and **refuses to start** when something is unsafe or
broken. It names the problem in the log without printing any secret. It refuses:

- a live Stripe key
- SeeWhy's database or VPS
- a weak `JWT_SECRET`
- a private media IP
- `http://` for `APP_URL`

## Limits to know about

- **One server process.** Live rooms, video and rate limits live in that process's memory.
  Don't run a second copy (`pm2 scale`). The server refuses `REDIS_URL` for this reason.
  One process on KVM 2 handles a lot of chat and browsing; video is the real ceiling.
  More capacity means a bigger VPS first; spreading across servers is a later project.
- **Rooms end themselves.** A live room whose host has been gone for 2 minutes
  (closed the tab, phone died, never came back after a restart) ends by itself.
- **Real payments** need the legal review and Stripe's live activation first.
