const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isInt, isStr, LISTING_TYPES, LISTING_GRADES, MAX_PRICE_CENTS } = require('../validate');

const router = express.Router();
const MAX_TEMPLATES = 20;

// GET /api/templates — my saved listing drafts, most recently saved first
router.get('/', requireAuth, async (req, res) => {
  try {
    const r = await db.query('select * from listing_templates where user_id = $1 order by updated_at desc', [req.user.id]);
    res.json(r.rows);
  } catch (err) {
    console.error('[templates/list]', err);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// POST /api/templates — save a draft. Saving a name you already have (any capitalisation) UPDATES it.
router.post('/', requireAuth, writeLimiter, async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const price = b.priceCents === undefined ? 0 : b.priceCents;
  const description = b.description === undefined ? '' : b.description;
  if (!isStr(name, 1, 60)) return res.status(400).json({ error: 'name is required (1-60 characters)' });
  if (!isStr(b.category, 1, 40)) return res.status(400).json({ error: 'category is required (up to 40 characters)' });
  if (!LISTING_GRADES.includes(b.grade)) return res.status(400).json({ error: `grade must be one of ${LISTING_GRADES.join(', ')}` });
  if (!LISTING_TYPES.includes(b.type)) return res.status(400).json({ error: `type must be one of ${LISTING_TYPES.join(', ')}` });
  if (!isInt(price, 0, MAX_PRICE_CENTS)) return res.status(400).json({ error: 'priceCents must be a whole number of cents' });
  if (!isStr(description, 0, 1000)) return res.status(400).json({ error: 'description must be 1000 characters or fewer' });

  try {
    const update = () => db.query(
      `update listing_templates set category=$3, grade=$4, type=$5, price_cents=$6, description=$7, updated_at=now()
       where user_id=$1 and lower(name)=lower($2) returning *`,
      [req.user.id, name, b.category, b.grade, b.type, price, description]
    );
    let r = await update();
    if (r.rows.length) return res.json(r.rows[0]);

    const count = await db.query('select count(*)::int as n from listing_templates where user_id = $1', [req.user.id]);
    if (count.rows[0].n >= MAX_TEMPLATES) {
      return res.status(409).json({ error: `You can keep up to ${MAX_TEMPLATES} templates — delete one first` });
    }
    try {
      r = await db.query(
        `insert into listing_templates (user_id, name, category, grade, type, price_cents, description)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.user.id, name, b.category, b.grade, b.type, price, description]
      );
      return res.status(201).json(r.rows[0]);
    } catch (err) {
      if (err.code === '23505') { r = await update(); return res.json(r.rows[0]); } // saved twice at the same instant
      throw err;
    }
  } catch (err) {
    console.error('[templates/save]', err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// DELETE /api/templates/:id — mine only (someone else's is just "not found")
router.delete('/:id', requireAuth, async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Template not found' });
  try {
    const r = await db.query('delete from listing_templates where id = $1 and user_id = $2', [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Template not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[templates/delete]', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = router;
