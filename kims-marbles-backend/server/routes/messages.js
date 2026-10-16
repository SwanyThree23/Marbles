// Direct messages. One conversation per pair of users (stored with user_a < user_b).
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isStr } = require('../validate');
const { notify } = require('../notify');

const router = express.Router();
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

// GET /api/conversations — my inbox, most recent first
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query(
      `select c.id, other.id as other_id, other.handle as other_handle, other.avatar_icon as other_icon,
         m.text as last_text, m.created_at as last_at,
         exists (select 1 from messages x where x.conversation_id = c.id and x.sender_id <> $1 and x.read_at is null) as unread
       from conversations c
       join users other on other.id = case when c.user_a = $1 then c.user_b else c.user_a end
       left join lateral (select text, created_at from messages where conversation_id = c.id order by id desc limit 1) m on true
       where $1 in (c.user_a, c.user_b)
       order by m.created_at desc nulls last limit 100`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

async function otherUser(req, res) {
  if (!isUuid(req.params.userId)) { res.status(404).json({ error: 'User not found' }); return null; }
  if (req.params.userId === req.user.id) { res.status(400).json({ error: 'You cannot message yourself' }); return null; }
  const u = (await db.query('select id, handle from users where id = $1', [req.params.userId])).rows[0];
  if (!u) { res.status(404).json({ error: 'User not found' }); return null; }
  return u;
}

// GET /api/conversations/with/:userId — the thread; marks their messages to me as read
router.get('/with/:userId', requireAuth, async (req, res, next) => {
  try {
    const other = await otherUser(req, res);
    if (!other) return;
    const [a, b] = pair(req.user.id, other.id);
    const c = (await db.query('select id from conversations where user_a = $1 and user_b = $2', [a, b])).rows[0];
    if (!c) return res.json({ conversationId: null, other, messages: [] });
    await db.query('update messages set read_at = now() where conversation_id = $1 and sender_id <> $2 and read_at is null', [c.id, req.user.id]);
    const m = await db.query('select id, sender_id, text, created_at, read_at from messages where conversation_id = $1 order by id desc limit 200', [c.id]);
    res.json({ conversationId: c.id, other, messages: m.rows.reverse() });
  } catch (err) { next(err); }
});

// POST /api/conversations/with/:userId   { text }
router.post('/with/:userId', requireAuth, writeLimiter, async (req, res, next) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  try {
    const other = await otherUser(req, res);
    if (!other) return;
    if (!isStr(text, 1, 2000)) return res.status(400).json({ error: 'Messages are 1 to 2000 characters' });
    const [a, b] = pair(req.user.id, other.id);
    const c = await db.query(
      `insert into conversations (user_a, user_b) values ($1, $2)
       on conflict (user_a, user_b) do update set user_a = excluded.user_a returning id`,
      [a, b]
    );
    const m = await db.query('insert into messages (conversation_id, sender_id, text) values ($1, $2, $3) returning *', [c.rows[0].id, req.user.id, text]);
    await notify(other.id, 'message', `New message from ${req.user.handle}`, c.rows[0].id);
    res.status(201).json(m.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
