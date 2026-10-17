# Kim's Marbles: readiness report

Status as of 2026-10-17, branch `claude/kims-marbles-finish-harden-6pmqhl`.

The original code was lost. The app was rebuilt from the recovered specs and tests:
the READMEs, the API table, the salvaged routes and tests, and the original preview.
Everything below was **run**, not assumed. Each piece was written test-first where
possible. **Mutation checks** were used throughout: the code was deliberately broken to
confirm a test fails.

## Verified

| Area | How | Result |
|---|---|---|
| Backend: auth, marketplace, offers, bids, collection, feed, DMs, battles, rooms, invites, moderation, payments, dashboard, games, templates, notifications, reports, rate limits | `node --test` against real Postgres and the real server process | **159/159** |
| Real-time: chat order, moderation, flood control, host commands, devices, settings sync, SFU signalling, one publishing device per person | real Socket.io clients and real mediasoup (part of the 159) | pass |
| Frontend: every page, the live room, the media client, theme, the CSP hash, reporting, the moderators' queue, the watch party | vitest + Testing Library | **114/114** |
| Real browsers, real media | Chromium with a fake camera, the built app, the real backend and SFU | **33/33** (TURN included) |
| Same suite through the **production nginx config** over HTTPS/WSS, with a real **coturn** relay | the config from `deploy/nginx/`, self-signed certificate | all pass ¹ |
| Mutation checks | broke the code on purpose, per stage | 72 of 73 caught; the 1 miss is an equivalent mutant (COMMIT on a failed Postgres transaction is a rollback) |
| Many users at once | `scripts/load-test.js`, one 4-core machine running both server and load | **1,610 simultaneous connections**: 802,907 chat deliveries with **0 lost**; latency p50 18 ms, p95 38 ms, p99 50 ms; 1,366 HTTP req/s with 0 errors (p95 47 ms); 302 MB memory |
| Real-time sync across devices | browser tests: theme and device list follow the person, a second device becomes a remote control with takeover, the server restarts mid-stream and both sides reconnect by themselves | pass |
| Deploy pieces | nginx 1.24 `nginx -t`, shellcheck, the migration as a non-superuser, backup → restore, smoke test through nginx | pass |

¹ Two tests were fixed on the way:

- One test assumed TURN was off.
- The "device disappears" check failed intermittently. That uncovered a real issue: the
  server took up to 45 s to notice a phone that dropped off the network. It now takes
  about 20 s, and both tests pass.

### Bugs found by testing and fixed

1. **Nobody could publish video on current Chrome.** The SDP answers from mediasoup-client
   3.11 no longer matched Chrome's offers. Upgraded to 3.23.2.
2. **Video never came back after a reconnect.** Closing the old producers stopped the
   page's own camera.
3. **A deploy stranded every viewer.** On shutdown the server told clients they were
   kicked, so they never reconnected.
4. **Rooms stayed "Live" forever** when the host just closed the tab. They now end after
   2 minutes without the host.
5. **The nginx config used `http2 on;`**, which Ubuntu 24.04's nginx (1.24) rejects. The
   site would not have started.
6. A shell quoting hazard in the setup script, plus phone layout and test-locator fixes.

## Not verified (needs the real VPS or real accounts)

- **`setup-vps.sh` end to end.** It needs the real VPS, DNS and Let's Encrypt. Each piece
  it runs was tested separately here.
- **Real Stripe API calls.** Checkout and Connect onboarding have not been called. Webhook
  signature checking and the fee maths are tested. Test mode only.
- **Real phones on real networks.** Tested so far: Chromium's fake camera, loopback
  networking and TURN on loopback. Not tested: iOS Safari, Android Chrome, cellular data,
  or real NATs. First thing to try once it's live.
- **Video capacity of the VPS.** Not measured: a real load test with many real video
  streams. Chat, API and connections were measured; video fan-out (each viewer receiving
  each person on stage) is the expected ceiling.
- **GitHub Actions CI.** The workflow is written but has not run on GitHub yet.

## Known gaps and limits

- **One server process.** Rooms, the SFU and rate limits live in its memory, and the
  server refuses `REDIS_URL`. To grow, get a bigger VPS first.
- **Backups stay on the same VPS.** Copy them off, or use Hostinger snapshots.
- **No email.** There is no address verification and no password reset by email.
- **Watch party** sends play/pause/restart to everyone, but it doesn't keep exact positions
  in sync. Someone who joins mid-video starts it from the beginning. Tested with a stand-in
  player; real YouTube playback still needs checking.
- **Moderators** can remove reported listings and posts. There is no way to ban a person yet.
- **Before real money:** the legal review and Stripe live activation. Live keys are refused
  until then.

## To go live

1. Buy the VPS (Hostinger KVM 2+, Ubuntu 24.04).
2. Point the `@`, `www` and `turn` A records at it.
3. Follow `kims-marbles-backend/DEPLOY.md`: one setup command, then the Hostinger firewall
   and the Stripe test keys.
