// Suspending an account. One place does all of it, in one transaction: mark the account,
// end every login, take down their active listings and end their live rooms. After commit
// their sockets are disconnected and their rooms' viewers are told the stream ended.
const db = require('./db');
const realtime = require('./realtime');

class BanError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function banUser(adminId, userId, reason = '') {
  const out = await db.tx(async (client) => {
    const u = (await client.query('select id, handle, is_admin, banned_at from users where id = $1 for update', [userId])).rows[0];
    if (!u) throw new BanError(404, 'User not found');
    if (u.id === adminId) throw new BanError(400, 'You cannot suspend yourself');
    if (u.is_admin) throw new BanError(400, 'Admins cannot be suspended here; remove their admin flag first');
    const r = await client.query(
      'update users set banned_at = coalesce(banned_at, now()), banned_reason = $2, banned_by = $3 where id = $1 returning id, handle, banned_at, banned_reason',
      [userId, reason, adminId]
    );
    await client.query("update refresh_tokens set revoked_at = coalesce(revoked_at, now()), revoked_reason = 'banned' where user_id = $1", [userId]);
    await client.query("update listings set status = 'removed' where seller_id = $1 and status = 'active'", [userId]);
    const rooms = await client.query(
      "update rooms set status = 'ended', ended_at = now() where host_id = $1 and status in ('live', 'scheduled') returning id", [userId]
    );
    for (const { id } of rooms.rows) await client.query('update room_participants set left_at = coalesce(left_at, now()) where room_id = $1', [id]);
    return { user: r.rows[0], endedRooms: rooms.rows.map((x) => x.id) };
  });
  realtime.disconnectUser(userId);
  for (const id of out.endedRooms) realtime.roomEnded(id);
  return out.user;
}

async function unbanUser(userId) {
  const r = await db.query(
    "update users set banned_at = null, banned_reason = '', banned_by = null where id = $1 returning id, handle", [userId]
  );
  if (!r.rows[0]) throw new BanError(404, 'User not found');
  return r.rows[0];
}

// who owns the thing a report is about
async function ownerOf(targetType, targetId) {
  const q = {
    listing: 'select seller_id as id from listings where id = $1',
    post: 'select author_id as id from posts where id = $1',
    comment: 'select author_id as id from post_comments where id = $1',
    panel: 'select host_id as id from rooms where id = $1',
    user: 'select id from users where id = $1',
  }[targetType];
  if (!q) return null;
  return (await db.query(q, [targetId])).rows[0]?.id || null;
}

module.exports = { banUser, unbanUser, ownerOf, BanError };
