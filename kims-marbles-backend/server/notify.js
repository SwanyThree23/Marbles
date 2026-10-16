// Notifications: a row for the bell, plus a live push to the user's devices once the
// real-time server has registered its emitter (index.js). Never throws into the caller.
const db = require('./db');

let emit = null; // (userId, event, payload) => void
function setEmitter(fn) { emit = fn; }

async function notify(userId, type, text, refId = null) {
  try {
    const r = await db.query(
      'insert into notifications (user_id, type, text, ref_id) values ($1, $2, $3, $4) returning *',
      [userId, type, text, refId]
    );
    if (emit) emit(userId, 'notification', r.rows[0]);
    return r.rows[0];
  } catch (err) {
    console.error('[notify]', err.message);
    return null;
  }
}

module.exports = { notify, setEmitter };
