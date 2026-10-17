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
const { requireAuth, SUSPENDED } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { isStr } = require('../validate');
const mailer = require('../mailer');

const router = express.Router();

const REFRESH_DAYS = 30;
const GRACE_SECONDS = 10;           // a token rotated this recently may be presented again
const BCRYPT_ROUNDS = 10;
const HANDLE_RE = /^[A-Za-z0-9_]{2,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// compared against when the email is unknown, so a miss takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicUser = (u) => ({ id: u.id, handle: u.handle, avatar_icon: u.avatar_icon, bio: u.bio, is_admin: u.is_admin, email_verified: !!u.email_verified_at, created_at: u.created_at });

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
    if (mailer.available()) sendConfirmation(r.rows[0]).catch((e) => console.error('[auth/register] confirmation email failed:', e.message));
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
    if (user.banned_at) return res.status(403).json({ error: SUSPENDED, suspended: true });
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
      if (!u.rows[0] || u.rows[0].banned_at) return null;
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

// ---- confirming the email address ----
const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
const escapeHtml = (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CONFIRM_DAYS = 7;
async function sendConfirmation(u) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.tx(async (client) => {
    await client.query('delete from email_verifications where user_id = $1', [u.id]); // only the newest link works
    await client.query(
      'insert into email_verifications (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))',
      [sha256(token), u.id, CONFIRM_DAYS]
    );
  });
  const link = `${appUrl()}/verify/${token}`;
  await mailer.send({
    to: u.email,
    subject: "Confirm your email for Kim's Marbles",
    text: `Hi ${u.handle},\n\nWelcome to Kim's Marbles! Please confirm this is your email address:\n\n${link}\n\nConfirming lets you reset your password by email if you ever forget it. If you didn't sign up, ignore this email.\n`,
    html: `<p>Hi ${escapeHtml(u.handle)},</p><p>Welcome to Kim's Marbles! Please confirm this is your email address:</p><p><a href="${link}">Confirm my email</a></p><p>Confirming lets you reset your password by email if you ever forget it. If you didn't sign up, ignore this email.</p>`,
  });
}

// POST /api/auth/verify { token } — from the emailed link; works logged in or out, once
router.post('/verify', authLimiter, async (req, res, next) => {
  const { token } = req.body || {};
  if (!isStr(token, 20, 200)) return res.status(400).json({ error: 'This confirmation link is not valid or has expired' });
  try {
    const ok = await db.tx(async (client) => {
      const r = await client.query(
        'update email_verifications set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id',
        [sha256(token)]
      );
      if (!r.rows[0]) return false;
      await client.query('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [r.rows[0].user_id]);
      return true;
    });
    if (!ok) return res.status(400).json({ error: 'This confirmation link is not valid or has expired' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/auth/verify/resend — a fresh link to my address
router.post('/verify/resend', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const u = (await db.query('select id, handle, email, email_verified_at from users where id = $1', [req.user.id])).rows[0];
    if (u.email_verified_at) return res.status(409).json({ error: 'Your email is already confirmed' });
    if (!mailer.available()) return res.status(503).json({ error: 'Email is not set up yet. Please contact support.' });
    await sendConfirmation(u);
    res.status(202).json({ ok: true, message: `A new confirmation link is on its way to ${u.email}.` });
  } catch (err) { next(err); }
});

// ---- forgotten password ----
const RESET_MINUTES = 30;

router.get('/reset-available', (_req, res) => res.json({ available: mailer.available() }));

// POST /api/auth/forgot { email } — always the same answer, whether or not the account exists,
// and the email goes out after the response, so timing does not tell either.
router.post('/forgot', authLimiter, async (req, res, next) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  if (!isStr(email, 3, 254) || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (!mailer.available()) return res.status(503).json({ error: 'Password reset by email is not set up yet. Please contact support.' });
  res.status(202).json({ ok: true, message: 'If an account with a confirmed email uses that address, a reset link is on its way.' });
  try {
    const u = (await db.query('select id, handle, email, banned_at, email_verified_at from users where lower(email) = lower($1)', [email])).rows[0];
    // only to a confirmed address: a typo at sign-up must not hand the account to that address's owner
    if (!u || u.banned_at || !u.email_verified_at) return;
    const token = crypto.randomBytes(32).toString('base64url');
    await db.tx(async (client) => {
      await client.query('delete from password_resets where user_id = $1', [u.id]); // only the newest link works
      await client.query(
        'insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))',
        [sha256(token), u.id, RESET_MINUTES]
      );
    });
    const link = `${appUrl()}/reset/${token}`;
    await mailer.send({
      to: u.email,
      subject: "Reset your Kim's Marbles password",
      text: `Hi ${u.handle},\n\nSomeone (hopefully you) asked to reset your Kim's Marbles password. Open this link within ${RESET_MINUTES} minutes to choose a new one:\n\n${link}\n\nIf it wasn't you, ignore this email: your password stays the same.\n`,
      html: `<p>Hi ${escapeHtml(u.handle)},</p><p>Someone (hopefully you) asked to reset your Kim's Marbles password. This link works for ${RESET_MINUTES} minutes:</p><p><a href="${link}">Choose a new password</a></p><p>If it wasn't you, ignore this email: your password stays the same.</p>`,
    });
  } catch (err) {
    console.error('[auth/forgot] could not send the reset email:', err.message);
    void next;
  }
});

// POST /api/auth/reset { token, password } — once per link; ends every existing login.
router.post('/reset', authLimiter, async (req, res, next) => {
  const { token, password } = req.body || {};
  if (!isStr(token, 20, 200)) return res.status(400).json({ error: 'This reset link is not valid or has expired' });
  if (!isStr(password, 8, 200)) return res.status(400).json({ error: 'Password must be 8-200 characters' });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = await db.tx(async (client) => {
      const r = await client.query(
        `update password_resets set used_at = now()
         where token_hash = $1 and used_at is null and expires_at > now() returning user_id`, [sha256(token)]
      );
      if (!r.rows[0]) return null;
      const id = r.rows[0].user_id;
      await client.query('update users set password_hash = $2 where id = $1', [id, hash]);
      await client.query("update refresh_tokens set revoked_at = coalesce(revoked_at, now()), revoked_reason = 'password_reset' where user_id = $1", [id]);
      return id;
    });
    if (!userId) return res.status(400).json({ error: 'This reset link is not valid or has expired' });
    if (onLogoutAll) onLogoutAll(userId);
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
