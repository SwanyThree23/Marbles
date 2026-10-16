// GET /api/dashboard — everything the Me dashboard shows, in one request.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

router.get('/', requireAuth, async (req, res, next) => {
  const tag = process.env.WEEKLY_CHALLENGE_TAG || '#SwirlChallenge';
  try {
    const r = await db.query(
      `select
         (select count(*)::int from listings where seller_id = $1 and status = 'active') as "activeListings",
         (select count(*)::int from offers where buyer_id = $1) as "offersSent",
         (select count(*)::int from posts where author_id = $1) as posts,
         (select count(*)::int from battles where $1 in (challenger_id, opponent_id)) as battles,
         (select count(*)::int from rooms where host_id = $1) as "roomsHosted",
         (select count(*)::int from collection_items where owner_id = $1) as "collectionCount",
         (select count(*)::int from posts where author_id = $1 and text ilike $2 escape '\\') as entries,
         (select count(*)::int from user_achievements where user_id = $1) as unlocked,
         (select count(*)::int from achievements) as total`,
      [req.user.id, `%${likeEscape(tag)}%`]
    );
    const g = await db.query('select game, best, plays from game_scores where user_id = $1', [req.user.id]);
    const games = { trivia: { best: 0, plays: 0 }, speed: { best: 0, plays: 0 } };
    for (const row of g.rows) games[row.game] = { best: row.best, plays: row.plays };
    const s = r.rows[0];
    res.json({
      stats: { activeListings: s.activeListings, offersSent: s.offersSent, posts: s.posts, battles: s.battles, roomsHosted: s.roomsHosted, collectionCount: s.collectionCount },
      challenge: { tag, entries: s.entries },
      achievements: { unlocked: s.unlocked, total: s.total },
      games,
    });
  } catch (err) { next(err); }
});

module.exports = router;
