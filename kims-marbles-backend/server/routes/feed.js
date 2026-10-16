// Community feed: posts, likes, comments.
const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isStr } = require('../validate');
const { award } = require('../achievements');
const { recordActivity } = require('../activity');

const router = express.Router();

// GET /api/feed — newest first; liked_by_me is false for anonymous viewers
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const r = await db.query(
      `select p.id, p.text, p.created_at, p.author_id, u.handle as author_handle, u.avatar_icon as author_icon,
         ci.name as attach_name, ci.icon as attach_icon,
         (select count(*)::int from post_likes l where l.post_id = p.id) as like_count,
         (select count(*)::int from post_comments c where c.post_id = p.id) as comment_count,
         exists (select 1 from post_likes l where l.post_id = p.id and l.user_id = $1) as liked_by_me
       from posts p join users u on u.id = p.author_id
       left join collection_items ci on ci.id = p.attach_item_id
       order by p.created_at desc, p.id limit 100`,
      [req.user?.id || null]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// POST /api/feed   { text, attachCollectionItemId? }
router.post('/', requireAuth, writeLimiter, async (req, res, next) => {
  const { text, attachCollectionItemId } = req.body || {};
  const body = typeof text === 'string' ? text.trim() : '';
  if (!isStr(body, 1, 2000)) return res.status(400).json({ error: 'Write something (up to 2000 characters)' });
  const attach = attachCollectionItemId || null;
  try {
    if (attach) {
      if (!isUuid(attach)) return res.status(400).json({ error: 'attachCollectionItemId must be one of your marbles' });
      const own = await db.query('select 1 from collection_items where id = $1 and owner_id = $2', [attach, req.user.id]);
      if (!own.rows.length) return res.status(400).json({ error: 'You can only attach a marble from your own collection' });
    }
    const r = await db.query('insert into posts (author_id, text, attach_item_id) values ($1, $2, $3) returning *', [req.user.id, body, attach]);
    await award(req.user.id, 'posted');
    await recordActivity(req.user.id, 'post', 'Posted to the community feed', r.rows[0].id);
    res.status(201).json({ ...r.rows[0], author_handle: req.user.handle });
  } catch (err) { next(err); }
});

const postExists = async (id) => isUuid(id) && (await db.query('select author_id from posts where id = $1', [id])).rows[0];

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const post = await postExists(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.author_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'You can only delete your own posts' });
    await db.query('delete from posts where id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/feed/:id/like — toggles
router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    if (!(await postExists(req.params.id))) return res.status(404).json({ error: 'Post not found' });
    const del = await db.query('delete from post_likes where post_id = $1 and user_id = $2', [req.params.id, req.user.id]);
    if (!del.rowCount) await db.query('insert into post_likes (post_id, user_id) values ($1, $2) on conflict do nothing', [req.params.id, req.user.id]);
    const n = await db.query('select count(*)::int as n from post_likes where post_id = $1', [req.params.id]);
    res.json({ liked: !del.rowCount, likeCount: n.rows[0].n });
  } catch (err) { next(err); }
});

router.get('/:id/comments', async (req, res, next) => {
  try {
    if (!(await postExists(req.params.id))) return res.status(404).json({ error: 'Post not found' });
    const r = await db.query(
      `select c.id, c.text, c.created_at, u.handle as author_handle from post_comments c
       join users u on u.id = c.author_id where c.post_id = $1 order by c.created_at, c.id limit 200`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/:id/comments', requireAuth, writeLimiter, async (req, res, next) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!isStr(text, 1, 1000)) return res.status(400).json({ error: 'Comments are 1 to 1000 characters' });
  try {
    if (!(await postExists(req.params.id))) return res.status(404).json({ error: 'Post not found' });
    const r = await db.query('insert into post_comments (post_id, author_id, text) values ($1, $2, $3) returning *', [req.params.id, req.user.id, text]);
    res.status(201).json({ ...r.rows[0], author_handle: req.user.handle });
  } catch (err) { next(err); }
});

module.exports = router;
