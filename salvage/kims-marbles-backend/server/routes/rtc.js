const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Browsers behind strict NATs or networks that block UDP can only reach the SFU
// through a TURN relay. coturn's "TURN REST API" scheme (use-auth-secret) lets us
// hand out SHORT-LIVED credentials without ever sending the shared secret:
//   username   = "<unix expiry>:<user id>"
//   credential = base64( HMAC-SHA1( secret, username ) )
// coturn recomputes the HMAC and refuses the credential after the expiry.
const MIN_TTL = 60;
const MAX_TTL = 86400;
const DEFAULT_TTL = 3600;

// config is read per request (not at boot) so it can be changed without a code change
const urls = (value, schemes) =>
  (value || '').split(',').map((s) => s.trim()).filter((s) => new RegExp(`^(${schemes}):[^\\s]+$`, 'i').test(s));

function ttlSeconds() {
  const n = parseInt(process.env.TURN_TTL_SECONDS || '', 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, n));
}

// GET /api/rtc/ice-servers — login required: an open endpoint would be an open relay
router.get('/ice-servers', requireAuth, (req, res) => {
  const ttl = ttlSeconds();
  const iceServers = [];

  const stun = urls(process.env.STUN_URLS, 'stuns?');
  if (stun.length) iceServers.push({ urls: stun });

  const turn = urls(process.env.TURN_URLS, 'turns?');
  const secret = process.env.TURN_SECRET;
  if (turn.length && secret) {
    const expiry = Math.floor(Date.now() / 1000) + ttl;
    const username = `${expiry}:${req.user.id}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turn, username, credential });
  } else if (turn.length) {
    console.warn('[rtc] TURN_URLS is set but TURN_SECRET is not — no TURN credentials will be issued');
  }

  res.set('Cache-Control', 'no-store'); // credentials are per-user and time-limited
  res.json({ iceServers, ttl });
});

module.exports = router;
