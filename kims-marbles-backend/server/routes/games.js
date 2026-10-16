const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { award } = require('../achievements');
const { recordActivity } = require('../activity');
const { isInt } = require('../validate');

const router = express.Router();

const GAMES = {
  trivia: { label: 'Marble Trivia', maxOutOf: 50 },
  speed: { label: 'Speed ID', maxScore: 1000 },
};
const QUIZ_WHIZ_RATIO = 0.7;

// POST /api/games/:game/score
//   trivia: { score, outOf }   speed: { score }
// Scores are reported by the client, so they are cosmetic (a personal best and a badge), not a
// competition. The server still validates them, keeps only the best, and awards "Quiz Whiz"
// itself — the client cannot grant that badge directly.
router.post('/:game/score', requireAuth, writeLimiter, async (req, res) => {
  const def = GAMES[req.params.game];
  if (!def) return res.status(404).json({ error: 'Unknown game' });
  const { score, outOf } = req.body || {};

  if (req.params.game === 'trivia') {
    if (!isInt(outOf, 1, def.maxOutOf)) return res.status(400).json({ error: `outOf must be a whole number from 1 to ${def.maxOutOf}` });
    if (!isInt(score, 0, outOf)) return res.status(400).json({ error: 'score must be a whole number from 0 to outOf' });
  } else if (!isInt(score, 0, def.maxScore)) {
    return res.status(400).json({ error: `score must be a whole number from 0 to ${def.maxScore}` });
  }

  try {
    const r = await db.query(
      `with prev as (select best from game_scores where user_id = $1 and game = $2)
       insert into game_scores (user_id, game, best, plays) values ($1, $2, $3, 1)
       on conflict (user_id, game) do update
         set best = greatest(game_scores.best, $3), plays = game_scores.plays + 1, updated_at = now()
       returning best, plays, ($3 > coalesce((select best from prev), 0)) as "newBest"`,
      [req.user.id, req.params.game, score]
    );
    const row = r.rows[0];

    if (req.params.game === 'trivia' && score / outOf >= QUIZ_WHIZ_RATIO) await award(req.user.id, 'quizWhiz');
    if (row.newBest) {
      await recordActivity(req.user.id, 'game', req.params.game === 'trivia'
        ? `New ${def.label} best: ${score}/${outOf}` : `New ${def.label} best: ${score} in a row`);
    }
    res.json({ best: row.best, plays: row.plays, newBest: row.newBest });
  } catch (err) {
    console.error('[games/score]', err);
    res.status(500).json({ error: 'Failed to save score' });
  }
});

module.exports = router;
