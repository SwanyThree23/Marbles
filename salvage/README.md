# Salvage: pieces of Kim's Marbles recovered from chat uploads

These are the files that were uploaded individually from the chat where Kim's Marbles was
built, saved here so they can't be lost when that sandbox resets. Each one sits at the path
the project's own READMEs give it. 22 unique files; duplicate uploads were dropped by
content hash, and the three older backend READMEs are in `history/`.

**This is not a runnable project.** It can't be installed, tested or deployed: the core is
missing. Once the full project is in this repo, compare it against these files (they are
the newest versions that were uploaded) and delete this folder.

## Present

| Path | What it is |
|---|---|
| `kims-marbles-backend/server/socketGuard.js` | `guard()`, host/room checks, chat moderation matcher + cache, flood-protection token buckets |
| `kims-marbles-backend/server/routes/templates.js` | saved listing templates (max 20, per user) |
| `kims-marbles-backend/server/routes/games.js` | trivia / Speed ID best scores; server awards Quiz Whiz |
| `kims-marbles-backend/server/routes/rtc.js` | `GET /api/rtc/ice-servers` with short-lived coturn credentials |
| `kims-marbles-backend/server/tests/dashboard.test.js` | 23 tests: earned-only achievements, activity, games, templates, validation |
| `kims-marbles-backend/server/tests/ratelimit.test.js` | 8 token-bucket tests |
| `kims-marbles-backend/deploy/turnserver.conf` | coturn production template |
| `kims-marbles-backend/README.md`, `DEPLOY.md` | newest versions (148/148 backend tests claimed) |
| `kims-marbles-frontend/src/App.jsx` | routes + auth gate (pasted in chat) |
| `kims-marbles-frontend/src/lib/userSocket.js` | one authenticated socket per device: settings sync, device list |
| `kims-marbles-frontend/src/lib/ice.js` | fetches and caches TURN credentials |
| `kims-marbles-frontend/e2e-browser/*.test.mjs` | real-browser tests: dashboard, devices, TURN, chat + theme |
| `kims-marbles-frontend/README.md`, `e2e-browser/README.md` | newest versions |
| `marbleverse-preview.html` | the single-file prototype (uploaded as `index.html`) |
| `CLAUDE_CODE_PROMPT.md` | the finish-and-harden prompt |

## Missing (named in the READMEs, never uploaded)

Backend: `schema.sql`, `rls.sql`, `seed.sql`, `docker-compose.yml`, `server/package.json`,
`server/app.js`, `server/index.js`, `server/db.js`, `server/validate.js`, `server/stripe.js`,
`server/achievements.js`, `server/activity.js`, `server/middleware/*`,
`server/mediasoup/{worker,rooms,signaling}.js`, every other route (`auth`, `listings`,
`collection`, `rooms`, `battles`, `feed`, `messages`, `reports`, `users`, `achievements`,
`notifications`, `payments`, `moderation`, `dashboard`, `activity`), `server/tests/setup.js` and
the other test files, `deploy/nginx.conf`, `deploy/turnserver.test.conf`, `.env.example`,
`.github/workflows/ci.yml`, `client-reference/mediaClient.js`.

Frontend: `package.json`, `vite.config.*`, `index.html` (with the no-flash theme script),
`src/main.jsx`, `src/App.css`, `src/index.css`, `src/LiveRoom.jsx`, `src/lib/mediaClient.js`,
`src/lib/api.js`, `src/lib/theme.js`, `src/lib/learnData.js`, `src/context/AuthContext.jsx`,
`src/components/*` (LiveChat, TipModal, InviteGuest, ModerationSettings, Layout, ...),
`src/pages/*`, all unit tests, `src/e2e*.test.jsx`, `e2e-browser/helpers.mjs` and the other
browser tests (`live-room.test.mjs`, ...).

The one-step fix: in the other chat, ask for **both project folders as a single zip**, then
upload it here (GitHub: Add file -> Upload files) or attach it in Claude Code.
