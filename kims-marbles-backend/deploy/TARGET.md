# Deployment target (decided 2026-10-16)

- **Domain:** `vibenbones.online` (app at `https://vibenbones.online`, relay at `turn.vibenbones.online`).
- **Server:** a dedicated VPS for Kim's Marbles only. Ubuntu 24.04, Hostinger KVM 2 or larger.
- **Never** deploy to the VPS at `2.24.194.112` (`srv1581658.hstgr.cloud`): it runs SeeWhy LIVE
  (`seewhylive.online`) and `vibenbones.shop`. Kim's Marbles shares no server, database or
  credentials with SeeWhy.
- DNS for `vibenbones.online` (A records -> the new VPS IP): `@`, `www`, `turn`.
- `APP_URL=https://vibenbones.online`, `CORS_ORIGINS=https://vibenbones.online`.
- New VPS IP: _not yet provided_.
