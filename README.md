# Kim's Marbles

*Where you can find your marbles.* A marketplace and live-streaming app for marble collectors:
buy, sell, trade and auction; live panels with up to 50 people on stage; PK-battles; a
community feed; direct messages; tips.

| Folder | What |
|---|---|
| `kims-marbles-backend/` | Node 22 server: REST API, Socket.io real-time, mediasoup media server, Postgres schema, deploy files |
| `kims-marbles-frontend/` | React 19 + Vite app |
| `camera-switch/` | front/back camera switching module (also used by the app) |
| `salvage/` | files recovered from the original project, kept for reference |

**Deploying:** [`kims-marbles-backend/DEPLOY.md`](kims-marbles-backend/DEPLOY.md) — one
dedicated VPS at vibenbones.online.

## Run it locally

Needs Node 22 and Postgres 16.

```bash
cd kims-marbles-backend/server
npm ci
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/km_test npm run test:db
DATABASE_URL=postgres://postgres@127.0.0.1:5432/km_test JWT_SECRET=dev NODE_ENV=development npm run dev
```
```bash
cd kims-marbles-frontend
npm ci
npm run dev        # http://localhost:5173, talks to the API on :4100
```

## Tests

| Suite | Command | What it runs against |
|---|---|---|
| Backend | `cd kims-marbles-backend/server && npm run test:db && npm test` | real Postgres, the real server as a child process, real Socket.io clients, real mediasoup |
| Frontend unit | `cd kims-marbles-frontend && npx vitest run` | jsdom, network faked at the API layer |
| Real browser | `cd kims-marbles-frontend && npm run test:browser` | real Chromium with a fake camera, the built app, the real backend and media server (see `e2e-browser/README.md`) |
| Smoke (a deployed site) | `node kims-marbles-backend/server/scripts/smoke.js https://vibenbones.online` | the live site |
| Load | `node kims-marbles-backend/server/scripts/load-test.js --url http://127.0.0.1:4100` | a local server started with `NODE_ENV=test` |

CI (`.github/workflows/ci.yml`) runs the backend, frontend, deploy-config and real-browser suites on every push.
