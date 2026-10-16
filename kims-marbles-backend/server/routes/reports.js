// Reports (moderation queue). Anyone logged in can file one; only admins see and resolve them.
// The admin flag is set from the database (see DEPLOY.md), never through the API.
const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isStr } = require('../validate');

const router = express.Router();
const TYPES = ['listing', 'post', 'user', 'panel', 'comment'];

router.post('/', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  const label = b.targetLabel === undefined ? '' : b.targetLabel;
  const details = b.details === undefined ? '' : b.details;
  if (!TYPES.includes(b.targetType)) return res.status(400).json({ error: `targetType must be one of ${TYPES.join(', ')}` });
  if (!isUuid(b.targetId)) return res.status(400).json({ error: 'targetId must be an id' });
  if (!isStr(b.reason, 1, 100)) return res.status(400).json({ error: 'Pick a reason' });
  if (!isStr(label, 0, 200) || !isStr(details, 0, 1000)) return res.status(400).json({ error: 'Details must be 1000 characters or fewer' });
  try {
    const r = await db.query(
      'insert into reports (reporter_id, target_type, target_id, target_label, reason, details) values ($1, $2, $3, $4, $5, $6) returning *',
      [req.user.id, b.targetType, b.targetId, label, b.reason, details]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/reports?status=open|actioned|dismissed   admins
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  const status = ['open', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : null;
  try {
    const r = await db.query(
      `select r.*, u.handle as reporter_handle from reports r join users u on u.id = r.reporter_id
       where ($1::text is null or r.status = $1) order by (r.status = 'open') desc, r.created_at limit 200`,
      [status]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// PATCH /api/reports/:id   { status: actioned | dismissed }   admins
router.patch('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Report not found' });
  const { status } = req.body || {};
  if (!['actioned', 'dismissed'].includes(status)) return res.status(400).json({ error: 'status must be actioned or dismissed' });
  try {
    const r = await db.query('update reports set status = $2, resolved_by = $3, resolved_at = now() where id = $1 returning *', [req.params.id, status, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Report not found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
