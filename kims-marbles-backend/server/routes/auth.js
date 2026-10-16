// Accounts and sessions.
//   access token  — HS256 JWT, JWT_ACCESS_EXPIRES (default 15m), sent as a Bearer header
//   refresh token — 32 random bytes; only its sha-256 is stored. One login = one "family".
// Every refresh retires the presented token and issues a new one in the same family.
// Presenting a retired token again (after the grace window) is treated as theft: the whole
// family is revoked, so both the thief and the real user must log in again.
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { isStr } = require('../validate');

const router = express.Router();

const REFRESH_DAYS = 30;
const GRACE_SECONDS = 10;           // a token rotated this recently may be presented again
const BCRYPT_ROUNDS = 10;
const HANDLE_RE = /^[A-Za-z0-9_]{2,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// compared against when the email is unknown, so a miss takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicUser = (u) => ({ id: u.id, handle: u.handle, avatar_icon: u.avatar_icon, bio: u.bio, is_admin: u.is_admin, created_at: u.created_at });

function accessToken(user) {
  return jwt.sign({ sub: user.id, handle: user.handle }, process.env.JWT_SECRET, {
    algorithm: 'HS256', expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m',
  });
}

async function issueRefreshToken(client, userId, familyId = crypto.randomUUID()) {
  const token = crypto.randomBytes(32).toString('base64url');
  await client.query(
    `insert into refresh_tokens (user_id, family_id, token_hash, expires_at)
     values ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, familyId, sha256(token), REFRESH_DAYS]
  );
  return token;
}

// Kill a whole login. The reason overwrites "rotated" on older tokens so none of them get grace.
const revokeFamily = (client, familyId, reason) => client.query(
  'update refresh_tokens set revoked_at = coalesce(revoked_at, now()), revoked_reason = $2 where family_id = $1',
  [familyId, reason]
);

async function session(user) {
  return { user: publicUser(user), accessToken: accessToken(user), refreshToken: await issueRefreshToken(db, user.id) };
}

router.post('/register', authLimiter, async (req, res, next) => {
  const { handle, email, password } = req.body || {};
  if (!isStr(handle) || !HANDLE_RE.test(handle)) return res.status(400).json({ error: 'Handle must be 2-24 letters, numbers or underscores' });
  if (!isStr(email, 3, 254) || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!isStr(password, 8, 200)) return res.status(400).json({ error: 'Password must be 8-200 characters' });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await db.query(
      'insert into users (handle, email, password_hash) values ($1, $2, $3) returning *',
      [handle, email.trim(), hash]
    );
    res.status(201).json(await session(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      const what = /handle/.test(err.constraint || '') ? 'That handle is taken' : 'An account with that email already exists';
      return res.status(409).json({ error: what });
    }
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!isStr(email, 1, 254) || !isStr(password, 1, 200)) return res.status(400).json({ error: 'Enter your email and password' });
  try {
    const r = await db.query('select * from users where lower(email) = lower($1)', [email.trim()]);
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Wrong email or password' });
    res.json(await session(user));
  } catch (err) { next(err); }
});

router.post('/refresh', authLimiter, async (req, res, next) => {
  const { refreshToken } = req.body || {};
  if (!isStr(refreshToken, 1, 200)) return res.status(400).json({ error: 'refreshToken is required' });
  try {
    const out = await db.tx(async (client) => {
      const r = await client.query(
        `select t.*, extract(epoch from now() - t.revoked_at) as revoked_ago, t.expires_at < now() as expired
         from refresh_tokens t where t.token_hash = $1 for update`,
        [sha256(refreshToken)]
      );
      const row = r.rows[0];
      if (!row || row.expired) return null;
      if (row.revoked_at) {
        const inGrace = row.revoked_reason === 'rotated' && Number(row.revoked_ago) <= GRACE_SECONDS;
        if (!inGrace) { await revokeFamily(client, row.family_id, 'reuse'); return null; }
      } else {
        await client.query("update refresh_tokens set revoked_at = now(), revoked_reason = 'rotated' where id = $1", [row.id]);
      }
      const u = await client.query('select * from users where id = $1', [row.user_id]);
      if (!u.rows[0]) return null;
      return { user: u.rows[0], refreshToken: await issueRefreshToken(client, row.user_id, row.family_id) };
    });
    if (!out) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    res.json({ user: publicUser(out.user), accessToken: accessToken(out.user), refreshToken: out.refreshToken });
  } catch (err) { next(err); }
});

// Always 204: logging out of an unknown session is still "logged out".
router.post('/logout', async (req, res, next) => {
  const { refreshToken } = req.body || {};
  try {
    if (isStr(refreshToken, 1, 200)) {
      const r = await db.query('select family_id from refresh_tokens where token_hash = $1', [sha256(refreshToken)]);
      if (r.rows[0]) await revokeFamily(db, r.rows[0].family_id, 'logout');
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

let onLogoutAll = null; // set by the real-time server: disconnects the user's sockets
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await db.query(
      "update refresh_tokens set revoked_at = coalesce(revoked_at, now()), revoked_reason = 'logout_all' where user_id = $1",
      [req.user.id]
    );
    if (onLogoutAll) onLogoutAll(req.user.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query('select * from users where id = $1', [req.user.id]);
    res.json({ ...publicUser(r.rows[0]), email: r.rows[0].email });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.GRACE_SECONDS = GRACE_SECONDS;
module.exports.setOnLogoutAll = (fn) => { onLogoutAll = fn; };
module.exports.publicUser = publicUser;
