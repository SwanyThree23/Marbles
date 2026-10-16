const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/activity?limit=1..50 (default 30; larger values are capped at 50) — my history only
router.get('/', requireAuth, async (req, res, next) => {
  let limit = 30;
  if (req.query.limit !== undefined) {
    if (!/^\d+$/.test(String(req.query.limit)) || Number(req.query.limit) < 1) return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
    limit = Math.min(50, Number(req.query.limit));
  }
  try {
    const r = await db.query('select seq, kind, text, ref_id, created_at from activity_events where user_id = $1 order by seq desc limit $2', [req.user.id, limit]);
    res.json(r.rows);
  } catch (err) { next(err); }
});

module.exports = router;
