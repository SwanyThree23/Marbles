// Public profiles, my profile edits, follows.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isStr } = require('../validate');
const { award } = require('../achievements');
const { notify } = require('../notify');
const { publicUser } = require('./auth');

const router = express.Router();

// PATCH /api/users/me   { bio?, avatarIcon? }   (handle, email and admin are never set here)
router.patch('/me', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  if (b.bio !== undefined && !isStr(b.bio, 0, 280)) return res.status(400).json({ error: 'bio must be 280 characters or fewer' });
  if (b.avatarIcon !== undefined && !isStr(b.avatarIcon, 1, 8)) return res.status(400).json({ error: 'avatarIcon must be a short emoji' });
  try {
    const r = await db.query(
      'update users set bio = coalesce($2, bio), avatar_icon = coalesce($3, avatar_icon) where id = $1 returning *',
      [req.user.id, b.bio === undefined ? null : b.bio.trim(), b.avatarIcon === undefined ? null : b.avatarIcon]
    );
    res.json(publicUser(r.rows[0]));
  } catch (err) { next(err); }
});

// GET /api/users/:handle — public profile + stats
router.get('/:handle', async (req, res, next) => {
  if (!isStr(req.params.handle, 1, 24)) return res.status(404).json({ error: 'User not found' });
  try {
    const r = await db.query(
      `select u.id, u.handle, u.avatar_icon, u.bio, u.created_at,
         (select count(*)::int from listings l where l.seller_id = u.id and l.status = 'active') as listings,
         (select count(*)::int from offers o join listings l on l.id = o.listing_id
            where o.status in ('accepted', 'paid') and (o.buyer_id = u.id or l.seller_id = u.id)) as trades,
         (select count(*)::int from follows f where f.followee_id = u.id) as followers,
         (select count(*)::int from follows f where f.follower_id = u.id) as following
       from users u where lower(u.handle) = lower($1)`,
      [req.params.handle]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/users/:id/follow — toggles
router.post('/:id/follow', requireAuth, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'User not found' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself' });
  try {
    if (!(await db.query('select 1 from users where id = $1', [req.params.id])).rows.length) return res.status(404).json({ error: 'User not found' });
    const del = await db.query('delete from follows where follower_id = $1 and followee_id = $2', [req.user.id, req.params.id]);
    if (del.rowCount) return res.json({ following: false });
    await db.query('insert into follows (follower_id, followee_id) values ($1, $2) on conflict do nothing', [req.user.id, req.params.id]);
    await award(req.user.id, 'followed');
    await notify(req.params.id, 'follow', `${req.user.handle} started following you`, req.user.id);
    res.json({ following: true });
  } catch (err) { next(err); }
});

module.exports = router;
