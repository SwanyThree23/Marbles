const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/achievements — every badge, with whether I have earned it
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query(
      `select a.key, a.name, a.description, a.icon, ua.unlocked_at, (ua.user_id is not null) as unlocked
       from achievements a left join user_achievements ua on ua.achievement_key = a.key and ua.user_id = $1
       order by a.key`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// Achievements are earned by doing the real thing; a client can never award one.
router.post('/:key/unlock', requireAuth, (_req, res) => {
  res.status(403).json({ error: 'Achievements are earned automatically when you do the activity' });
});

module.exports = router;
