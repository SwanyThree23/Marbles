# Kim's Marbles — Backend

Real backend for the Kim's Marbles preview. Mirrors the SeeWhy LIVE server pattern
(Node/Express + `pg.Pool`, Supabase Postgres, Socket.io) but lives in its **own repo
and own Supabase project** — do not point this at SeeWhy's `xlrcibziouffgxciecvc` project.

## What's here

- `schema.sql` — full Postgres schema: users, listings/offers/auctions/bids,
  collection, rooms (panels/broadcasts), watch-party queue/state, battles + gifts,
  feed posts/likes/comments, conversations/messages, room chat, notifications,
  achievements, reports (moderation), payments (Stripe Connect).
- `rls.sql` — Row Level Security policies for every table (run after
  `schema.sql`). Own-row writes, participant-only reads on private data
  (messages, notifications, payments, offers), public reads on marketplace/feed/rooms.
- `server/` — Express API + Socket.io skeleton
  - `routes/auth.js` — register/login/refresh (bcrypt + JWT, mirrors SeeWhy's rotation pattern)
  - `routes/listings.js` — marketplace CRUD, offers, auction bids (row-locked)
  - `routes/collection.js` — owned-marble inventory
  - `routes/rooms.js` — panels/broadcasts (schedule, go live, join/leave) + watch-party queue/state
  - `routes/battles.js` — PK-Battle challenge/accept/decline, gifting, leaderboard
  - `routes/feed.js` — community posts, likes, comments
  - `routes/messages.js` — DM inbox + threads
  - `routes/reports.js` — moderation queue
  - `routes/users.js` — public profiles, follow/unfollow
  - `routes/achievements.js`, `routes/notifications.js`
  - `routes/payments.js` — Stripe Connect onboarding, checkout, webhook (90/10 split)
  - `index.js` — mounts all routes + Socket.io events for room chat, reactions,
    screen-share signaling, watch-party sync, and battle gifting
- `server/mediasoup/` — the audio/video SFU
  - `worker.js` — worker pool, codec config, WebRTC transport creation
  - `rooms.js` — in-memory router/peer state per room (one mediasoup Router per room)
  - `signaling.js` — Socket.io events a client uses to actually get media flowing:
    `ms:join`, `ms:create-transport`, `ms:connect-transport`, `ms:produce`,
    `ms:consume`, `ms:resume-consumer`, `ms:close-producer`, `ms:leave`
- `server/stripe.js` — Stripe client + the one place that computes the 10%
  platform fee (`Math.floor()`, never rounded up)
- `server/app.js` — the Express app alone (routes, middleware, no `listen()`,
  no Socket.io, no mediasoup). This is what the test suite imports.
- `server/index.js` — boots `app.js` into an actual server: http + Socket.io
  + mediasoup worker init + `listen()`. This is what `npm start`/PM2 runs.
- `docker-compose.yml` — a throwaway local Postgres (port 5433) for dev/tests,
  separate from your real Supabase project.
- `server/tests/` — `node:test` + `supertest`, run against a real Postgres
  (not mocked). Covers register/login/refresh and listings CRUD/ownership/
  auction-bid-locking. **Verified passing: 11/11** against a live schema.
- `.github/workflows/ci.yml` — runs the test suite on every push/PR against a
  Postgres service container.
- `client-reference/mediaClient.js` — a reference `mediasoup-client` wiring
  module (ES module, for the real Vite/React frontend — not used by the HTML
  preview). Shows the full join → create transports → publish camera/mic/screen
  → consume other peers → leave flow against `server/mediasoup/signaling.js`.
- `seed.sql` — local dev sample data (4 users, listings, an auction, a live
  room, a live battle, feed posts). All seeded users' password is
  `password123` (real bcrypt hash, verified) — dev only, never reuse.
- `server/middleware/rateLimit.js` — `authLimiter` (10 req/15min on
  register/login/refresh) and `writeLimiter` (30 req/min) applied to every
  write endpoint that's spam- or brute-force-prone: listings, offers, bids,
  posts, comments, messages, reports.
- `server/middleware/logger.js` — minimal request logger (method, path,
  status, timing) so `pm2 logs` shows abuse patterns without a heavier
  logging dependency.

## What's NOT here yet (next passes)

- **Swapping the preview's tiles onto this SFU** — `client-reference/mediaClient.js`
  is the wiring; actually replacing the preview artifact's plain `getUserMedia`
  calls with it is a frontend task once the real React app exists.
- **TURN server** — `worker.js` only configures STUN-equivalent UDP/TCP
  listening; guests behind restrictive NATs (symmetric NAT, some corporate
  wifi) will need a TURN relay (coturn) for reliable connections in production.
- `users.is_admin` has no route to set it yet — flip it directly in Supabase
  for your own account until an admin-management UI exists.
- `writeLimiter` is per-process in-memory (via `express-rate-limit`'s default
  store) — fine for a single VPS instance, but switch to a Redis store before
  running more than one server process behind a load balancer.
- Test coverage is auth + listings only so far — rooms/battles/feed/messages/
  payments routes are exercised manually but don't have `node:test` coverage yet.

## Setup

```bash
cd server
cp .env.example .env
# fill in SUPABASE_DB_URL (new project), both JWT secrets, MEDIASOUP_ANNOUNCED_IP,
# and Stripe keys (test keys are fine until you're ready for real payouts)
npm install
```

> `mediasoup` compiles a native addon on install (needs Python 3 + a C++
> toolchain). On the VPS: `apt install -y python3 build-essential` first if
> `npm install` fails on it. This is the same class of native-build step as
> anything else in the mediasoup/FFmpeg pipeline you're already running.

Apply the schema to your new Supabase project:

```bash
psql "$SUPABASE_DB_URL" -f ../schema.sql
psql "$SUPABASE_DB_URL" -f ../rls.sql
```

Run locally:

```bash
npm run dev
```

## Running tests

```bash
docker compose up -d                    # from the repo root — starts local Postgres on :5433
psql "postgres://postgres:postgres@localhost:5433/kims_marbles" -f ../schema.sql
cd server && npm install
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/kims_marbles npm test
```

CI (`.github/workflows/ci.yml`) does the same thing automatically on every
push/PR using a Postgres service container. Note: `npm install` also compiles
mediasoup's native worker, so both local installs and a fresh CI run take a
few minutes the first time.

## Deploy (matches your existing VPS/PM2 pattern)

```bash
# on the VPS, under /opt/ (separate from /opt/seewhy)
git clone <this-repo> kims-marbles
cd kims-marbles/server
npm install --production
cp .env.example .env   # fill in real values
pm2 start index.js --name kims-marbles-server   # index.js, not app.js — this is the one that listens
pm2 save
```

Add an nginx server block + subdomain (e.g. `api.kimsmarbles.app`) proxying to
the PM2 port, same as SeeWhy's `srv1587098.hstgr.cloud` setup.

## API quick reference

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /api/auth/register | — | handle, email, password |
| POST | /api/auth/login | — | email, password |
| POST | /api/auth/refresh | — | refreshToken |
| GET | /api/listings | optional | ?category=&type=&q= |
| POST | /api/listings | required | create a listing |
| PATCH | /api/listings/:id | required | owner only, e.g. mark sold |
| DELETE | /api/listings/:id | required | owner only |
| POST | /api/listings/:id/offers | required | kind: buy \| offer \| trade |
| POST | /api/listings/:id/bids | required | row-locked, enforces min increment |
| GET/POST/DELETE | /api/collection | required | owned-marble inventory |
| GET | /api/rooms | optional | ?status=live |
| POST | /api/rooms | required | title, category, scheduledFor \| goLiveNow |
| PATCH | /api/rooms/:id | required | host only — status: live \| ended |
| POST | /api/rooms/:id/join, /leave | required | |
| GET | /api/rooms/:id/watchparty | optional | state + queue |
| POST | /api/rooms/:id/watchparty/load | required | host loads a video |
| POST | /api/rooms/:id/watchparty/queue | required | add a video to the queue |
| GET | /api/battles | required | ?mine=1 |
| GET | /api/battles/leaderboard | — | top collectors by gift points |
| POST | /api/battles | required | opponentId, wagerType, roundSeconds |
| POST | /api/battles/:id/accept, /decline | required | opponent only |
| POST | /api/battles/:id/gift | required | side, giftName, points |
| POST | /api/battles/:id/end | required | resolves winner |
| GET | /api/feed | optional | |
| POST | /api/feed | required | text, attachCollectionItemId? |
| POST | /api/feed/:id/like | required | toggles |
| GET/POST | /api/feed/:id/comments | required (post) | |
| GET | /api/conversations | required | inbox list |
| GET/POST | /api/conversations/with/:userId | required | thread + send |
| POST | /api/reports | required | targetType, targetId, reason |
| GET | /api/users/:handle | — | public profile + stats |
| POST | /api/users/:id/follow | required | toggles |
| GET | /api/achievements | required | all badges + unlocked state |
| POST | /api/achievements/:key/unlock | required | idempotent |
| GET | /api/notifications | required | |
| PATCH | /api/notifications/:id/read | required | |
| POST | /api/payments/onboard | required | Stripe Connect Express account link |
| GET | /api/payments/status | required | whether payouts are enabled |
| POST | /api/payments/checkout | required | Checkout Session for an accepted offer |
| POST | /api/payments/webhook | — (Stripe-signed) | `checkout.session.completed` marks paid + sold |

Socket.io events (all namespaced under the default connection):
`room:join`, `room:leave`, `room:chat`, `room:reaction`, `room:screen-share`,
`watchparty:load`, `watchparty:control`, `battle:join`, `battle:gift`.

MediaSoup signaling events (ack-callback style, one call per step):
`ms:join`, `ms:create-transport`, `ms:connect-transport`, `ms:produce`,
`ms:consume`, `ms:resume-consumer`, `ms:close-producer`, `ms:leave`.
