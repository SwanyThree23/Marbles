# Kim's Marbles — Frontend

Full React port of the HTML preview: Marketplace, Panels, PK-Battles, Feed,
Collection, Learn, and Me — all wired to the real backend, plus the live
room's real MediaSoup camera/mic/screen-share integration and the
server-authoritative host controls (mute-a-guest, layout) proven to sync
across devices.

**Verified by building it, not by assuming it**: `npm run build` produces a
clean production bundle (112 modules, no errors), and I grepped the compiled
output to confirm every page's real content is actually in there —
"List a Marble", "Join Panel", "Create Battle", "Feature My Collection",
"Marble Trivia", "Set Up Payouts", "#SwirlChallenge" — not just written and
hoped for.

## Invite links

`/join/:token` (`src/pages/JoinInvite.jsx`) is the landing page for a host's
one-time invite. An unauthenticated visitor sees the login/register screen at
that same URL first; then the page redeems the token (POST), joins the room,
and renders the live room as a guest. Refreshing is safe (redemption is
idempotent for the same person); a second person using the same link is told
it has already been used. Hosts generate the link with the 🔗 button in the live room (`components/InviteGuest.jsx`, calls
`POST /api/rooms/:id/invite`) and copy it.

## Dashboard, templates and games

`/dashboard` (📊 in the nav) shows, from the server: stats (active listings, offers, posts, battles,
streams hosted, marbles owned), this week's challenge and your entries, achievements progress and
badges, your personal bests, **saved listing templates** (Use / Delete) and your **activity
history**. Each section loads on its own, so one failing request never blanks the page (it shows a
Retry for just that section). Templates are saved from the listing form ("💾 Save as Template"),
shared across devices (server-side, max 20), and "Use" opens the form pre-filled via
`/market?template=<id>`. The listing form also now refuses a junk price like "abc" instead of
silently creating a free listing.

Learn has 7-question **trivia** and the **Speed ID** game; both save your best on the server, and
the server awards **Quiz Whiz** itself for 70%+ (the client can no longer award badges). Speed ID's
timer lives in a ref and ends the run exactly once: an earlier version made the end-of-run decision
inside a React state updater and saved the score several times (a test now guards it, including
under StrictMode). Verified in real browsers: real UI actions appear on the dashboard, a template
round-trips (save, reuse, delete), both games save to the server, a perfect trivia run earns the
badge, and **no page scrolls sideways at phone width** (this found a Messages overflow).

## Multiple devices

`src/lib/userSocket.js` keeps ONE authenticated real-time connection per signed-in device (started
by `AuthContext`, with a fresh token on every reconnect). Choosing Light / Dark / System on one
device is relayed to the same person's other devices only; "System" there means *follow that
device's own setting*. A change received from another device is applied without being echoed back.
Me shows a live **Your devices** list and **Sign out of all devices** (revokes every login on the
server, and signs out here only after the server confirms). Verified with two real browser contexts
as one person plus a stranger (`e2e-browser/devices.test.mjs`): the theme follows the person and
never reaches the stranger, the list updates as a device appears and disappears, and after
sign-out-everywhere the other device's refresh token is dead on the server.

**Flood protection** is server-side (see the backend README); the chat shows a short "sending too
fast" notice when throttled.

## TURN (connecting users behind strict NATs)

`src/lib/ice.js` fetches short-lived TURN credentials (`GET /api/rtc/ice-servers`), caches them
for 80% of their lifetime, and `mediaClient` hands them to **both** media transports. A failed
lookup never stops anyone joining (a direct connection is still tried). Support/testing switch:
`localStorage.kmIceTransportPolicy = 'relay'` forces relay-only media. Verified against a real
coturn (`e2e-browser/turn.test.mjs`): relay-only browsers exchange video, every nominated media
path is a `relay` candidate, coturn's log shows both users allocating, and with no ICE servers, a
forged credential, or an expired one, no media flows. Server setup: `kims-marbles-backend/DEPLOY.md` 6.7.

## Sessions

The backend's access tokens last 15 minutes, so `src/lib/api.js` keeps the
session alive: it refreshes a token that is about to expire *before* a request
(this also stops public routes like the feed from silently treating you as
logged out), retries once on a 401, shares one refresh between simultaneous
requests, and only ends the session if the server actually **rejects** the
refresh token — a flaky network or 5xx never logs anyone out. The backend
*rotates* refresh tokens on every refresh (the app stores the new one each time),
and "Log Out" revokes the login on the server, not just locally. A refresh that
finishes after the user switched accounts is discarded. Sockets get a token
*function*, so a reconnect after expiry carries a fresh token, and a refresh
never restarts a live stream.

## Dropped connections

If the live connection drops (a phone leaving wifi, a tunnel), socket.io
reconnects the same socket — but the server has already removed your peer and
closed your transports, so the old media session is dead. `LiveRoom` shows
"Reconnecting…", then rebuilds the session: a new media client, rejoin,
republish the **same** camera (no new permission prompt, mic/cam mute state
kept, a live screen share republished), and re-consume everyone else. Remote
tiles from the dead session are cleared. Our own hang-up (`io client
disconnect`) is ignored.
Covered by unit tests with a fake media client **and** by the real-browser
suite (`npm run test:browser`), which drops a real guest's websocket and checks
the host sees them again on a brand-new media session, with no ghost tile.

## Structure

- `src/context/AuthContext.jsx` — login/register/logout, shared everywhere
- `src/lib/api.js` — one fetch wrapper every page uses
- `src/components/Layout.jsx` — nav shell
- `src/pages/*.jsx` — one file per screen, mirrors the preview's tabs exactly
- `src/LiveRoom.jsx` + `src/lib/mediaClient.js` — the real-time piece: actual
  camera/mic through MediaSoup, host controls via the proven `roomSync` events

## Setup

```bash
npm install
cp .env.example .env   # set VITE_API_URL to your deployed backend
npm run dev
```

## Tests

```bash
npm test                 # 215 unit/component tests (mocked network)
npm run test:e2e         # 19 tests against a REAL backend (fresh DB each run)
npm run test:browser     # 26 tests in a REAL browser with real WebRTC (+4 TURN tests when E2E_TURN=1; e2e-browser/README.md)
```
Unit tests cover: watch party, clip recorder/Vault, SwanyBot, the live room
wiring (incl. invite button and "a token refresh must not restart the stream"),
the invite landing page, session keep-alive (refresh, single-flight, account-
switch race), socket token handling, and an `<App/>` smoke test (auth gate +
every lazy-loaded route).

What the mocked unit tests do NOT prove: the real `MediaRecorder`, Web Speech
API, YouTube iframe, camera, and MediaSoup client are stand-ins there. The live
room's video path is covered separately by the real-browser suite below.

### Real-browser tests (`e2e-browser/`)

Real Chromium with a **fake camera + mic**, the built app, the real backend,
real MediaSoup, real WebRTC — nothing mocked. 18 tests, all passing (two full
runs in a row, zero server errors). The original six:

1. two people see **one tile each**, with live audio + video tracks and video
   actually *playing* (frames decoded, clock advancing) in both directions
2. host mute / camera controls round-trip through the real server
3. the **same host account on a second device** gets host controls, receives the
   already-applied state on join, and its changes show up on the first device
4. a **screen share** is its own tile for everyone and disappears when stopped
5. a **dropped connection** (the guest's websocket is really closed): the guest
   rebuilds its session on fresh tracks, the host sees them again, no ghost tile
6. an **invite link** opened in a real browser puts a guest in the room; a second
   person using it is refused

Bugs this suite found that no mocked test could: every remote person showed up
as **two tiles** (one empty, audio-only) with two sets of host buttons, and a
host opening their own room from another device joined as a plain guest.

Added since: **cross-device sync** (4 tests, `devices.test.mjs`); **chat** across two browsers; **reactions**; **moderation end to
end** (the host sets the list in the real UI, three browsers, a blocked message
reaches nobody and the host is flagged); **tipping** (viewers get 💰, host does not,
a host without payouts gets a clear message); the **Stripe return page**
`/live/:id?tip=success`; **theming** (follows the system live, a manual choice wins,
no flash with all app JS blocked, text over video stays readable in light mode);
a **UDP transport check** from the browser's own WebRTC stats; and **layout**
checks that every call control and the chat box are fully visible, unclipped and
uncovered on a laptop and a phone (390x844), and that the phone header and nav
fit. Bugs these found that unit tests could not: dark-on-dark name labels in light
mode, a call-control bar that overflowed a phone screen and sat under a floating
helper button, a chat box hidden below the fold, and a header whose bell / Go Live /
Log Out were off-screen on phones.

What it does NOT cover: other browsers (Firefox, Safari, mobile), real NAT /
TURN / lossy networks (everything runs over loopback), more than a handful of
participants, real hardware cameras. `getDisplayMedia` is shimmed to the fake
camera in headless mode.

### Real-backend session test (2-second tokens)

`src/e2e-session.test.jsx` runs against a backend started with
`JWT_ACCESS_EXPIRES=2s`, so tokens really expire during the test: expired token
refreshed transparently, identity kept on public routes, the reactive 401 path,
a page rendering after expiry, and a rejected refresh ending the session. It
includes a control proving an expired token is rejected *without* this logic,
plus checks that refresh rotates the stored token and that logging out really
revokes the login on the server.
```bash
JWT_ACCESS_EXPIRES=2s PORT=4101 node index.js     # in the backend, with your test DB env
E2E_SESSION=1 VITE_API_URL=http://localhost:4101 npx vitest run src/e2e-session.test.jsx
```

### Real-backend contract tests

`src/e2e.test.jsx` makes **no API mocks**. It registers two users through the
live HTTP API, seeds listings / an auction / collection items / a feed post +
like / a live room / a battle with a gift / a DM / an offer, then renders the
actual pages as that user and checks the data shows up correctly:

```bash
# backend + Postgres running (see ../kims-marbles-backend/DEPLOY.md)
VITE_API_URL=http://localhost:4100 npm run test:e2e
```
It is skipped by a plain `npm test` (it needs a live server) and **refuses to run against a
non-empty database** with a clear message (its assertions assume nothing else exists). 12 tests:
Marketplace (prices in dollars, seller, auction bid, **server-side category
filter**, **Place Bid actually raises the bid**), Feed (author, like count,
challenge filter), Collection (summed value + leaderboard), Panels (live room,
host, capacity), Battles (leaderboard points from a real gift), Me
(achievement unlocked server-side, payout status), Messages (conversation,
unread marker, opening the thread), and the notification bell (real offer +
challenge-accepted notifications with the unread badge).

Run against a local backend with a throwaway Postgres: **12/12 passing, zero
5xx responses from the server**. This verifies the REST contract between the
pages and the API. It does **not** cover Socket.io real-time behaviour, the
MediaSoup SFU or Stripe (the SFU is covered by the real-browser suite below).

## Honest gaps

- **Still missing from the React app** (present in `marbleverse-preview.html`): front/back camera
  switching on phones.
- **Not pixel-matched to the preview** — functional styling, not the preview's polish.
- **Clip trimming is playback-only** — the trim range is saved with the clip and
  respected when you play it, but the file itself is the full captured buffer.
  A physically cut file needs ffmpeg.wasm. The Vault is in-memory: clips are
  lost on a full page reload (video blobs are too big for localStorage).
- **Watch party sync is reload-based**, not frame-accurate (that would need the
  YouTube IFrame API).
- **Bundle**: route-level code splitting is done (main ~280 kB / 89 kB gzip;
  the 283 kB `mediasoup-client` chunk only loads when entering a live room).
- **Never run against your *deployed* server or over a real network.** The REST
  contract and the real-time video path are tested locally (see above), over
  loopback, in one browser engine.
