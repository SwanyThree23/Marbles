// A host's live-chat blocked-word list. Applied by the server in the room:chat handler
// (socketGuard.findBlockedWord) before anything is broadcast.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { invalidateModeration } = require('../socketGuard');

const router = express.Router();
const MAX_WORDS = 100;
const MAX_LEN = 40;

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query('select enabled, words from moderation_settings where user_id = $1', [req.user.id]);
    res.json(r.rows[0] || { enabled: false, words: [] });
  } catch (err) { next(err); }
});

// PUT /api/moderation   { enabled, words[] }  trimmed, lowercased, de-duplicated, blanks dropped
router.put('/', requireAuth, async (req, res, next) => {
  const { enabled, words } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  if (!Array.isArray(words) || !words.every((w) => typeof w === 'string')) return res.status(400).json({ error: 'words must be a list of words or phrases' });
  const clean = [...new Set(words.map((w) => w.trim().toLowerCase()).filter(Boolean))];
  if (clean.length > MAX_WORDS) return res.status(400).json({ error: `Up to ${MAX_WORDS} words` });
  if (clean.some((w) => w.length > MAX_LEN)) return res.status(400).json({ error: `Each word or phrase can be up to ${MAX_LEN} characters` });
  try {
    const r = await db.query(
      `insert into moderation_settings (user_id, enabled, words, updated_at) values ($1, $2, $3, now())
       on conflict (user_id) do update set enabled = $2, words = $3, updated_at = now() returning enabled, words`,
      [req.user.id, enabled, clean]
    );
    invalidateModeration(req.user.id);
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
