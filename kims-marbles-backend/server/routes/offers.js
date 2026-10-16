// The offers inbox: sellers see and answer offers on their listings; buyers see their own.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isUuid } = require('../validate');
const { notify } = require('../notify');

const router = express.Router();
const OFFER_SELECT = `
  select o.*, l.name as listing_name, l.seller_id, s.handle as seller_handle, b.handle as buyer_handle
  from offers o join listings l on l.id = o.listing_id join users s on s.id = l.seller_id join users b on b.id = o.buyer_id`;

// GET /api/offers?role=seller|buyer
router.get('/', requireAuth, async (req, res, next) => {
  const col = req.query.role === 'buyer' ? 'o.buyer_id' : 'l.seller_id';
  try {
    res.json((await db.query(`${OFFER_SELECT} where ${col} = $1 order by o.created_at desc limit 100`, [req.user.id])).rows);
  } catch (err) { next(err); }
});

// PATCH /api/offers/:id   { status: accepted | declined }   seller only, pending only
router.patch('/:id', requireAuth, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Offer not found' });
  const { status } = req.body || {};
  try {
    const o = (await db.query(`${OFFER_SELECT} where o.id = $1`, [req.params.id])).rows[0];
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    if (o.seller_id !== req.user.id) return res.status(403).json({ error: 'Only the seller can answer this offer' });
    if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'status must be accepted or declined' });
    const r = await db.query("update offers set status = $2 where id = $1 and status = 'pending' returning *", [o.id, status]);
    if (!r.rows[0]) return res.status(409).json({ error: 'This offer has already been answered' });
    await notify(o.buyer_id, `offer_${status}`, `${req.user.handle} ${status} your offer on "${o.listing_name}"`, o.id);
    res.json({ ...o, ...r.rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
