// A user's activity history, written by the server when something happens (never by the
// client). Only the newest KEEP events per user are kept.
const db = require('./db');
const KEEP = 200;

async function recordActivity(userId, kind, text, refId = null) {
  await db.query('insert into activity_events (user_id, kind, text, ref_id) values ($1, $2, $3, $4)', [userId, kind, text, refId]);
  await db.query(
    `delete from activity_events where user_id = $1 and seq <= (
       select seq from activity_events where user_id = $1 order by seq desc offset $2 limit 1)`,
    [userId, KEEP]
  );
}

module.exports = { recordActivity, KEEP };
