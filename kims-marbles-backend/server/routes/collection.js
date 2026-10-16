// Owned-marble inventory. Values are self-reported (estimated), not verified.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isInt, isStr } = require('../validate');
const { award } = require('../achievements');

const router = express.Router();
const COLLECTOR_AT = 3;

// GET /api/collection/leaderboard — public, by total estimated value
router.get('/leaderboard', async (_req, res, next) => {
  try {
    const r = await db.query(
      `select u.handle, count(*)::int as item_count, sum(ci.est_value_cents)::bigint as total_value_cents
       from collection_items ci join users u on u.id = ci.owner_id
       group by u.id, u.handle order by total_value_cents desc, u.handle limit 20`
    );
    res.json(r.rows.map((x) => ({ ...x, total_value_cents: Number(x.total_value_cents) })));
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json((await db.query('select * from collection_items where owner_id = $1 order by created_at desc', [req.user.id])).rows);
  } catch (err) { next(err); }
});

// POST /api/collection   { name, icon?, estValueCents?, acquiredVia? }
router.post('/', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const icon = b.icon === undefined ? '🔮' : b.icon;
  const value = b.estValueCents === undefined ? 0 : b.estValueCents;
  if (!isStr(name, 1, 80)) return res.status(400).json({ error: 'name is required (up to 80 characters)' });
  if (!isStr(icon, 1, 8)) return res.status(400).json({ error: 'icon must be a short emoji' });
  if (!isInt(value, 0, 2_000_000_000)) return res.status(400).json({ error: 'estValueCents must be a whole number of cents' });
  if (b.acquiredVia != null && !isUuid(b.acquiredVia)) return res.status(400).json({ error: 'acquiredVia must be a listing id' });
  try {
    let via = b.acquiredVia || null;
    if (via && !(await db.query('select 1 from listings where id = $1', [via])).rows.length) via = null;
    const r = await db.query('insert into collection_items (owner_id, name, icon, est_value_cents, acquired_via) values ($1, $2, $3, $4, $5) returning *', [req.user.id, name, icon, value, via]);
    const n = await db.query('select count(*)::int as n from collection_items where owner_id = $1', [req.user.id]);
    if (n.rows[0].n >= COLLECTOR_AT) await award(req.user.id, 'collector');
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not in your collection' });
  try {
    const r = await db.query('delete from collection_items where id = $1 and owner_id = $2', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not in your collection' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
