// Achievements are EARNED: only server code calls award(), after the real action happened.
const db = require('./db');

// Returns true when this call unlocked it (false if the user already had it).
async function award(userId, key) {
  const r = await db.query(
    'insert into user_achievements (user_id, achievement_key) values ($1, $2) on conflict do nothing',
    [userId, key]
  );
  return r.rowCount === 1;
}

module.exports = { award };
