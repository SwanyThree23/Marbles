// PK-battles: challenge -> accept/decline -> gifts while live -> end (winner by points).
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isInt, isStr } = require('../validate');
const { award } = require('../achievements');
const { recordActivity } = require('../activity');
const { notify } = require('../notify');

const router = express.Router();
const BATTLE_SELECT = `
  select b.*, c.handle as challenger_handle, o.handle as opponent_handle
  from battles b join users c on c.id = b.challenger_id join users o on o.id = b.opponent_id`;

// GET /api/battles/leaderboard — public: collectors ranked by gift points received
router.get('/leaderboard', async (_req, res, next) => {
  try {
    const r = await db.query(
      `select u.id, u.handle, sum(g.points)::int as points
       from battle_gifts g join battles b on b.id = g.battle_id
       join users u on u.id = case when g.side = 'challenger' then b.challenger_id else b.opponent_id end
       group by u.id, u.handle order by points desc, u.handle limit 20`
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// GET /api/battles?mine=1 — my battles; otherwise live battles
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const mine = req.query.mine === '1';
    const r = await db.query(
      `${BATTLE_SELECT} where ${mine ? '$1 in (b.challenger_id, b.opponent_id)' : "b.status = 'live' and $1::uuid is not null"}
       order by b.created_at desc limit 50`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// POST /api/battles   { opponentId, wagerType?, wagerItemId?, roundSeconds? }
router.post('/', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  const wagerType = b.wagerType === undefined ? 'points' : b.wagerType;
  const roundSeconds = b.roundSeconds === undefined ? 300 : b.roundSeconds;
  if (!isUuid(b.opponentId)) return res.status(400).json({ error: 'opponentId must be a user id' });
  if (b.opponentId === req.user.id) return res.status(400).json({ error: 'You cannot challenge yourself' });
  if (!['points', 'marble'].includes(wagerType)) return res.status(400).json({ error: 'wagerType must be points or marble' });
  if (!isInt(roundSeconds, 60, 3600)) return res.status(400).json({ error: 'roundSeconds must be 60 to 3600' });
  try {
    const opp = (await db.query('select id, handle from users where id = $1', [b.opponentId])).rows[0];
    if (!opp) return res.status(404).json({ error: 'That collector does not exist' });
    let wagerItemId = null;
    if (wagerType === 'marble') {
      if (!isUuid(b.wagerItemId)) return res.status(400).json({ error: 'Pick a marble from your collection to stake' });
      const own = await db.query('select 1 from collection_items where id = $1 and owner_id = $2', [b.wagerItemId, req.user.id]);
      if (!own.rows.length) return res.status(400).json({ error: 'You can only stake a marble you own' });
      wagerItemId = b.wagerItemId;
    }
    const r = await db.query(
      `insert into battles (challenger_id, opponent_id, wager_type, wager_item_id, round_seconds)
       values ($1, $2, $3, $4, $5) returning *`,
      [req.user.id, opp.id, wagerType, wagerItemId, roundSeconds]
    );
    const battle = r.rows[0];
    await notify(opp.id, 'challenge', `${req.user.handle} challenged you to a PK-Battle`, battle.id);
    await award(req.user.id, 'challenged');
    await recordActivity(req.user.id, 'battle', `Challenged ${opp.handle} to a PK-Battle`, battle.id);
    res.status(201).json({ ...battle, challenger_handle: req.user.handle, opponent_handle: opp.handle });
  } catch (err) { next(err); }
});

// Locks the battle row and runs fn(battle, client); fn returns { httpStatus, body } for a refusal,
// otherwise the updated battle row (which has its own `status` column, hence httpStatus).
async function withBattle(req, res, next, fn) {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Battle not found' });
  try {
    const out = await db.tx(async (client) => {
      const r = await client.query('select * from battles where id = $1 for update', [req.params.id]);
      if (!r.rows[0]) return { httpStatus: 404, body: { error: 'Battle not found' } };
      return fn(r.rows[0], client);
    });
    if (out.httpStatus) return res.status(out.httpStatus).json(out.body);
    const full = (await db.query(`${BATTLE_SELECT} where b.id = $1`, [out.id])).rows[0];
    res.status(out.created ? 201 : 200).json(full);
    if (out.after) await out.after(full);
  } catch (err) { next(err); }
}

const answer = (accept) => (req, res, next) => withBattle(req, res, next, async (b, client) => {
  if (b.opponent_id !== req.user.id) return { httpStatus: 403, body: { error: 'Only the challenged collector can answer' } };
  if (b.status !== 'pending') return { httpStatus: 409, body: { error: 'This challenge has already been answered' } };
  const r = await client.query(
    `update battles set status = $2, started_at = case when $2 = 'live' then now() end where id = $1 returning *`,
    [b.id, accept ? 'live' : 'declined']
  );
  return { ...r.rows[0], after: async () => {
    await notify(b.challenger_id, accept ? 'challenge_accepted' : 'challenge_declined',
      `${req.user.handle} ${accept ? 'accepted' : 'declined'} your PK-Battle challenge`, b.id);
    if (accept) await recordActivity(req.user.id, 'battle', 'Accepted a PK-Battle challenge', b.id);
  } };
});
router.post('/:id/accept', requireAuth, answer(true));
router.post('/:id/decline', requireAuth, answer(false));

// POST /api/battles/:id/gift   { side, giftName, points }   anyone, while live
router.post('/:id/gift', requireAuth, writeLimiter, (req, res, next) => {
  const { side, giftName, points } = req.body || {};
  if (!['challenger', 'opponent'].includes(side)) return res.status(400).json({ error: 'side must be challenger or opponent' });
  if (!isStr(giftName, 1, 40)) return res.status(400).json({ error: 'giftName is required (up to 40 characters)' });
  if (!isInt(points, 1, 10000)) return res.status(400).json({ error: 'points must be a whole number from 1 to 10000' });
  return withBattle(req, res, next, async (b, client) => {
    if (b.status !== 'live') return { httpStatus: 409, body: { error: 'This battle is not live' } };
    await client.query('insert into battle_gifts (battle_id, sender_id, side, gift_name, points) values ($1, $2, $3, $4, $5)', [b.id, req.user.id, side, giftName, points]);
    const col = side === 'challenger' ? 'challenger_points' : 'opponent_points';
    const r = await client.query(`update battles set ${col} = ${col} + $2 where id = $1 returning *`, [b.id, points]);
    return { ...r.rows[0], created: true };
  });
});

// POST /api/battles/:id/end — the two battlers only, while live
router.post('/:id/end', requireAuth, (req, res, next) => withBattle(req, res, next, async (b, client) => {
  if (![b.challenger_id, b.opponent_id].includes(req.user.id)) return { httpStatus: 403, body: { error: 'Only the two battlers can end a battle' } };
  if (b.status !== 'live') return { httpStatus: 409, body: { error: 'This battle is not live' } };
  const winner = b.challenger_points > b.opponent_points ? b.challenger_id : b.opponent_points > b.challenger_points ? b.opponent_id : null;
  const r = await client.query("update battles set status = 'ended', ended_at = now(), winner_id = $2 where id = $1 returning *", [b.id, winner]);
  return r.rows[0];
}));

module.exports = router;
