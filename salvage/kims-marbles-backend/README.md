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
  - `routes/auth.js` — register/login/refresh (bcrypt + JWT: 15-min access token, 30-day refresh token). refresh tokens are stored **hashed**, **rotate** on every refresh, and replaying a retired one kills that whole login (see *Sessions* below)
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
  (not mocked). Covers auth, listings, battles, feed, messages, rooms/watch-party,
  and users/follow. **Verified passing: 148/148** against a live schema — this
  run also caught and fixed a real bug (a Postgres parameter-type conflict in
  `rooms.js`'s room-creation query) before it ever hit production.
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
- Test coverage doesn't include payments/Stripe (needs a mocked Stripe client
  or the Stripe CLI's webhook forwarding to test meaningfully) or the
  Socket.io/mediasoup real-time layer (needs a socket.io-client test harness).

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

### Socket / real-time tests

`server/tests/socket-rooms.test.js` spawns the real server and drives it with
real Socket.io clients (no database needed — tokens are signed locally). It
guards two bugs found by running the React client's exact flow against the
server:

- **`ms:join` now joins the Socket.io room.** Everything room-scoped
  (`room:state`, `room:chat`, `watchparty:*`, `ms:new-producer`) is emitted to
  that room, but only `room:join` used to join it — and the React `LiveRoom`
  never sends `room:join`. Result: its host controls never updated and viewers
  never saw changes. Tests cover delivery to an `ms:join`-only client, the
  host's own echo, and no leakage into other rooms.
- **Graceful shutdown.** mediasoup's `Worker` installs its own SIGINT/SIGTERM
  handler, which disables Node's default exit-on-signal; the server then
  closed its workers and hung until force-killed. `index.js` now closes
  workers, disconnects clients, drains the DB pool and exits 0. Tested with
  clients still connected (exits in milliseconds, code 0).

### Dashboard data, achievements, and input validation

- **Achievements are earned, never claimed.** The server awards `listed` (creating a listing),
  `traded` (sending an offer / trade request, or a paid order), `challenged` (a battle challenge),
  `wentLive` (going live), `posted`, `followed`, `collector` (3 marbles) and `quizWhiz` (a 70%+ trivia
  score reported through `/api/games/trivia/score`). The old endpoint that let any user award
  themselves any badge now returns 403. The legacy single-file preview (`marbleverse-preview.html`)
  still calls it, so its badges no longer unlock; use the React app.
- **Activity history** (`activity_events`) is written by the server when something happens, never by
  the client; the latest 200 per user are kept. **Game bests** (`game_scores`) are reported by the
  client, so they are cosmetic (a personal best and a badge), not a competition.
- **Weekly challenge:** `WEEKLY_CHALLENGE_TAG` (default `#SwirlChallenge`) is the tag the dashboard
  counts in a member's own posts; change it in `.env` each week.
- **Bad input is a 400, never a 500.** Listings (type/grade/price/lengths), feed posts (<= 2000
  chars), collection items (name <= 80, value a whole number of cents), battle challenges (a real,
  different, existing opponent) and templates are all validated; previously several of these reached
  a database enum/foreign-key error and returned 500. Tests: `tests/dashboard.test.js` (23).

### Cross-device settings and the device list

Every authenticated socket joins a private `user:{id}` channel. `settings:sync` relays a
whitelisted setting (currently `theme`: `light` / `dark` / `system`) to that person's **other**
devices only: not echoed to the sender, never to another user, and anonymous sockets can't push.
`device:register` / `device:list` give each user a live list of their connected devices (capped
at 25; updated on connect and disconnect). Tests: the "cross-device" and "device list" cases in
`tests/socket-rooms.test.js`.

### TURN credentials

`GET /api/rtc/ice-servers` (login required) returns STUN and TURN entries from `STUN_URLS`,
`TURN_URLS` and `TURN_SECRET`. TURN credentials follow coturn's REST-API scheme
(`username = "<expiry>:<userId>"`, `credential = base64(HMAC-SHA1(secret, username))`, lifetime
`TURN_TTL_SECONDS`, 60 s - 24 h, default 1 h); the secret is never returned, responses are
`no-store`, and config URLs are restricted to `stun(s):`/`turn(s):`. Verified against a real
coturn: valid credentials are accepted, wrong-secret and expired ones rejected, and browsers
forced to relay-only still exchange video. See `DEPLOY.md` section 6.7.

### Live-chat moderation

A host's blocked-word list (`moderation_settings`, RLS: own row) is applied **by the
server in the `room:chat` handler, before anything is broadcast** — a blocked message
reaches nobody. The sender gets `room:chat:blocked`; the host gets `moderation:flagged`
on their `user:{id}` channel; the host is never blocked by their own list. Matching is
whole-word and case-insensitive ("ass" does not block "class"); symbol/emoji entries
match as substrings; regex characters are inert. The per-room lookup is cached for 10 s
and invalidated immediately when the host saves. Not caught: deliberate misspellings
("b@d"). Tests: `tests/moderation.test.js` (8) and the moderation cases in
`tests/socket-rooms.test.js`.

### Producer source (camera / mic / screen)

Each MediaSoup producer is tagged `video`, `audio` or `screen` (`appData.source`,
validated against that closed set — audio can never claim to be a screen) and
announced in `ms:new-producer` / `ms:join`'s `existingProducers`. A screen share
is also "video" to WebRTC, so without the tag clients can't tell it from a camera
and can't show one tile per person. Tests: `tests/producer-source.test.js`.

To exercise real WebRTC from a browser on the same machine, start the server with
`MEDIASOUP_ANNOUNCED_IP=127.0.0.1`.

### Sessions (refresh tokens)

- Refresh tokens are stored in `refresh_tokens` as a **sha-256 hash** (a database
  leak doesn't hand out sessions). RLS is on with no policy — server-only.
- **Rotation**: every `/refresh` retires the presented token and issues a new
  one in the same *family* (one login = one family).
- **Reuse detection**: replaying a retired token revokes the whole family — the
  thief *and* the legitimate client are signed out, which is the point.
- **Grace window (10 s)**: a token rotated moments ago may be presented again
  without penalty, so two tabs refreshing together, or a request retried after a
  flaky network, don't log the user out. Logged-out tokens get no grace.
- **Logout** (`/logout`, `/logout-all`) revokes server-side.
- Limits: access tokens are stateless JWTs, so one stays usable for up to 15
  minutes after logout; a refresh response lost in transit *beyond* the grace
  window ends that login (the user signs in again); there is no per-device
  session list yet. Tests: `tests/refresh-rotation.test.js` (14, mutation-checked).

### Access rules the server enforces

The UI hides host-only and participant-only controls, but only the server can
enforce them. These rules are covered by `tests/authz.test.js` and
`tests/socket-rooms.test.js` (each was a failing test before its fix):

| Area | Rule |
|---|---|
| Battles | Only the two battlers can end a battle, and only while it is live (an ended battle's winner can't be rewritten). |
| Battle gifts | Whole number of points, 1 to 10,000; `side` must be `challenger`/`opponent`; battle must be live. Anyone may gift (that is the audience's role). There is no socket path for gifts, so a score can't be broadcast that was never recorded. |
| Marketplace | A seller can't bid on their own auction or make an offer on their own listing; offers and bids need an *active* listing; `kind` and amounts are validated. |
| Watch party | Only the room host can load a video, over REST *and* over the socket. |
| Room controls | `room:command` (mute / camera / layout) is host-only, checked against `rooms.host_id`; a refused sender gets `{ ok: false }`. Anonymous sockets can't use it. |
| Room traffic | You must have joined a room to chat, react, or screen-share in it; chat is capped at 500 characters; watch-party ids must be real YouTube ids. |
| SFU | `ms:join` requires an existing, un-ended room (no router is created for invented ids); publishing media requires a login; per-peer caps on transports (4) and producers (3). |
| Invites | One-time, 2-hour links. Redeemed with a POST (a link-preview bot that only *fetches* the URL can't burn it). Idempotent for the person who claimed it, so a refresh doesn't lock them out; a second person is refused. |
| Flood protection | Token buckets per **user** (all of a user's sockets share one budget; anonymous sockets are per-socket): chat 5 burst / 1 per s, reactions 8 / 4, host commands 10 / 5, watch party 6 / 2, joins 5 / 1, device registration 3 / 0.2 per s, settings sync 10 / 2. Over the limit the event is dropped; chat senders get `room:chat:throttled { retryMs }`, command senders `{ ok:false }`. A connection sending > 150 events of any kind in a burst (50/s sustained) is disconnected. Buckets live in process memory like the rest of the real-time state. Tests: `tests/ratelimit.test.js` (8) + the flood cases in `tests/socket-rooms.test.js`. |
| Input | Every socket handler is wrapped in `guard()` (`server/socketGuard.js`): payloads are always objects and nothing a client sends can throw out of a handler. Before this, **one payload-less `room:join` from an anonymous client crashed the whole server.** |

Known limits: gifts are free (there is no wallet/purchase flow yet), so
points reflect effort, not money; collection values are self-reported;
room/host caches and room-state live in process memory (use the Redis
adapter and a shared store before running multiple instances).

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
| POST | /api/auth/refresh | — | refreshToken — **rotates**: returns a new access + refresh pair, retires the old |
| POST | /api/auth/logout | — | refreshToken — revokes that whole login; always 204 |
| POST | /api/auth/logout-all | required | revokes every device's login for this user |
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
| GET | /api/rooms/:id | optional | one room with its host (404 for unknown or malformed ids) |
| GET | /api/rooms/:id/watchparty | optional | state + queue |
| GET | /api/rtc/ice-servers | required | STUN/TURN servers + short-lived TURN credentials (coturn REST scheme); `iceServers: []` if none configured |
| GET | /api/moderation | required | this host's blocked-word list (defaults if never saved) |
| PUT | /api/moderation | required | `{ enabled, words[] }` — trimmed, lowercased, de-duplicated; <=100 words of <=40 chars |
| POST | /api/rooms/:id/watchparty/load | required | host loads a video |
| POST | /api/rooms/:id/watchparty/queue | required | add a video to the queue |
| POST | /api/rooms/:id/invite | required (host) | one-time link, expires in 2h |
| POST | /api/rooms/invite/:token | required | redeem a link (POST: it changes state). Same person may retry; a 2nd person gets 410 |
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
| POST | /api/achievements/:key/unlock | required | **always 403** — achievements are earned by the server, a client can't award them |
| GET | /api/dashboard | required | `{ stats, challenge: { tag, entries }, achievements: { unlocked, total }, games }` in one request |
| GET | /api/activity | required | my history, newest first (`?limit` 1-50, default 30); only my own events |
| POST | /api/games/:game/score | required | `speed`: `{ score }`; `trivia`: `{ score, outOf }` -> `{ best, plays, newBest }` |
| GET | /api/templates | required | my saved listing drafts |
| POST | /api/templates | required | save a draft (same name, any capitalisation, updates it; max 20 -> 409) |
| DELETE | /api/templates/:id | required | mine only; someone else's is 404 |
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
