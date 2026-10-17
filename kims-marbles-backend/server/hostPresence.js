// Ends live rooms whose host has gone. A host is "present" while any of their sockets is in
// the room (room:join or ms:join; a phone and a laptop both count). A sweep looks at every
// live room in the database; one whose host has been absent for HOST_GRACE_MS (default 2
// minutes) is ended exactly as if the host had pressed "End stream". One sweep covers every
// way a host can vanish: a closed tab, a dead phone, a host who never joined after creating
// the room, or a server restart (presence starts empty, so absent hosts are caught too).
//
// Presence is per-process memory, like the SFU itself: this assumes one server process.
const db = require('./db');
const realtime = require('./realtime');

const present = new Map();   // roomId -> Set<socketId> of the host's sockets in the room
const absentSince = new Map(); // roomId -> ms timestamp the host was first seen missing

function hostJoined(roomId, socketId) {
  if (!present.has(roomId)) present.set(roomId, new Set());
  present.get(roomId).add(socketId);
  absentSince.delete(roomId);
}

function hostLeft(roomId, socketId) {
  const set = present.get(roomId);
  if (!set) return;
  set.delete(socketId);
  if (!set.size) { present.delete(roomId); absentSince.set(roomId, Date.now()); }
}

// a socket disconnected: it leaves every room it was host-present in
function socketGone(socketId) {
  for (const roomId of [...present.keys()]) hostLeft(roomId, socketId);
}

// the room ended (by the host or by a sweep): nothing to track any more
function forget(roomId) { present.delete(roomId); absentSince.delete(roomId); }

async function endRoom(roomId) {
  const r = await db.query(
    "update rooms set status = 'ended', ended_at = now() where id = $1 and status = 'live' returning id",
    [roomId]
  );
  if (!r.rows.length) return false;
  await db.query('update room_participants set left_at = coalesce(left_at, now()) where room_id = $1', [roomId]);
  realtime.roomEnded(roomId);
  return true;
}

async function sweep(graceMs, now = Date.now()) {
  const live = (await db.query("select id from rooms where status = 'live'")).rows.map((r) => r.id);
  const liveSet = new Set(live);
  for (const id of [...absentSince.keys()]) if (!liveSet.has(id)) absentSince.delete(id);
  const ended = [];
  for (const id of live) {
    if (present.get(id)?.size) continue;
    if (!absentSince.has(id)) { absentSince.set(id, now); continue; }
    const gone = now - absentSince.get(id);
    if (gone >= graceMs && (await endRoom(id))) {
      absentSince.delete(id);
      ended.push(id);
      console.log(`[rooms] ended ${id}: the host was gone for ${Math.round(gone / 1000)}s`);
    }
  }
  return ended;
}

let timer = null;
function start({ graceMs = 120_000 } = {}) {
  const every = Math.max(100, Math.min(15_000, Math.floor(graceMs / 4)));
  const run = () => sweep(graceMs).catch((err) => console.error('[rooms] host sweep failed', err.message));
  timer = setInterval(run, every);
  timer.unref();
  run();
}
function stop() { clearInterval(timer); timer = null; }

const stats = () => ({ roomsWithHostPresent: present.size, roomsWithHostAbsent: absentSince.size });

module.exports = { hostJoined, hostLeft, socketGone, forget, sweep, start, stop, stats };
