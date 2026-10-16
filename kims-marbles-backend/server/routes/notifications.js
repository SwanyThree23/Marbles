const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUuid } = require('../validate');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json((await db.query('select * from notifications where user_id = $1 order by created_at desc, id limit 50', [req.user.id])).rows);
  } catch (err) { next(err); }
});

// PATCH /api/notifications/:id/read — mine only (anyone else's is "not found")
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Notification not found' });
  try {
    const r = await db.query('update notifications set read = true where id = $1 and user_id = $2', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Notification not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
