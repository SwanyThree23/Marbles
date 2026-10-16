// Bearer-token auth. Access tokens are short-lived HS256 JWTs (sub = user id). Every request
// re-reads the user, so a deleted account's tokens stop working at once.
const jwt = require('jsonwebtoken');
const db = require('../db');

function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
}

async function userFromRequest(req) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer (.+)$/i);
  if (!m) return null;
  let claims;
  try { claims = verifyAccessToken(m[1]); } catch (_e) { return null; }
  const r = await db.query('select id, handle, is_admin from users where id = $1', [claims.sub]);
  return r.rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Please log in' });
    req.user = user;
    next();
  } catch (err) { next(err); }
}

// Public routes that personalise when a valid token is present (e.g. "liked by me").
async function optionalAuth(req, _res, next) {
  try {
    req.user = await userFromRequest(req);
    next();
  } catch (err) { next(err); }
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}

module.exports = { requireAuth, optionalAuth, requireAdmin, verifyAccessToken };
