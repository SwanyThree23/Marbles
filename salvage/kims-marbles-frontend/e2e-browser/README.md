# Real-browser end-to-end tests

Real Chromium (fake camera + mic) → the built React app → the real backend →
real MediaSoup → real WebRTC. Nothing is mocked. Covers what unit/socket tests
can't: video actually playing both ways, host controls, the same host account on
two devices, screen share, a dropped connection, and invite links.

## Run

1. Backend + a **fresh** Postgres (see `../kims-marbles-backend/DEPLOY.md`), with
   media reachable from the browser on loopback:
   ```bash
   MEDIASOUP_ANNOUNCED_IP=127.0.0.1 NODE_ENV=test node index.js     # NODE_ENV=test skips rate limits
   ```
2. The app, built against that API and served with SPA routing:
   ```bash
   VITE_API_URL=http://localhost:4100 npm run build
   npx vite preview --port 4173
   ```
3. A browser: either `npx playwright-core install chromium`, or point `CHROME_PATH`
   at any Chromium/Chrome binary.
4. ```bash
   npm run test:browser
   ```
   Env: `APP_URL` (default `http://localhost:4173`), `API_URL` (default
   `http://localhost:4100`), `CHROME_PATH`.

Each test registers its own users and rooms, so runs don't collide, but use a
throwaway database. Real-media runs take about a minute.

## Gotchas (each cost real time)

- `--test-name-pattern` is **case-sensitive** and a pattern that matches nothing makes
  `node --test` hang with only `TAP version 13` printed. If a run goes silent, check the
  pattern against the exact test title first.
- Kill the servers by **PID**. `pkill -f` can match your own shell, and starting Vite via
  `npx` leaves the real process holding port 4173; launch
  `node node_modules/vite/bin/vite.js preview` instead.
- Use a **fresh database** per run (the real-backend suite assumes one).
- `EXPECT_TRANSPORT=tcp` flips the transport test's expectation (it fails against the
  default server, which offers UDP; that is the control that shows the test measures
  something).

## TURN tests (optional, need coturn)

`turn.test.mjs` is skipped unless `E2E_TURN=1`. It forces both browsers to **relay-only** media,
so video can only flow if the app got valid TURN credentials and coturn accepted them; negative
controls (no ICE servers, a forged credential, an expired one) must produce no media.

```bash
apt install -y coturn
turnserver -c ../kims-marbles-backend/deploy/turnserver.test.conf > /tmp/turn.log 2>&1 &
E2E_TURN=1 TURN_LOG=/tmp/turn.log TURN_SECRET=turn-test-secret \
  TURN_URLS='turn:127.0.0.1:3478?transport=udp' \
  # (start the backend with the same TURN_URLS / TURN_SECRET and MEDIASOUP_ANNOUNCED_IP=127.0.0.1)
  npm run test:browser
```
`turnserver.test.conf` allows loopback relaying — local testing only.
