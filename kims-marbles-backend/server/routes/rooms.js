// Live rooms (panels and broadcasts), one-time invites and the watch-party REST side.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isInt, isStr } = require('../validate');
const { award } = require('../achievements');
const { recordActivity } = require('../activity');
const realtime = require('../realtime');

const router = express.Router();
const YT_RE = /^[\w-]{11}$/;
const INVITE_MINUTES = 120;
const QUEUE_MAX = 50;
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

// a room with its host handle and the number of guests currently in it
const ROOM_SELECT = `
  select r.*, u.handle as host_handle,
    (select count(*)::int from room_participants p where p.room_id = r.id and p.left_at is null and p.user_id <> r.host_id) as guest_count
  from rooms r join users u on u.id = r.host_id`;

async function loadRoom(id) {
  if (!isUuid(id)) return null;
  return (await db.query(`${ROOM_SELECT} where r.id = $1`, [id])).rows[0] || null;
}

async function wentLive(room, userId) {
  await award(userId, 'wentLive');
  await recordActivity(userId, 'live', `Went live: "${room.title}"`, room.id);
}

// GET /api/rooms?status=live|scheduled|ended
router.get('/', optionalAuth, async (req, res, next) => {
  const { status } = req.query;
  const filter = ['live', 'scheduled', 'ended'].includes(status) ? 'where r.status = $1' : "where r.status <> 'ended'";
  try {
    const r = await db.query(`${ROOM_SELECT} ${filter} order by (r.status = 'live') desc, r.created_at desc limit 100`, filter.includes('$1') ? [status] : []);
    res.json(r.rows);
  } catch (err) { next(err); }
});

// POST /api/rooms   { title, category?, maxGuests?, scheduledFor? | goLiveNow? }
router.post('/', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const category = b.category === undefined ? 'General' : b.category;
  const maxGuests = b.maxGuests === undefined ? 6 : b.maxGuests;
  if (!isStr(title, 1, 120)) return res.status(400).json({ error: 'title is required (up to 120 characters)' });
  if (!isStr(category, 1, 40)) return res.status(400).json({ error: 'category must be up to 40 characters' });
  if (!isInt(maxGuests, 1, 50)) return res.status(400).json({ error: 'maxGuests must be 1 to 50' });
  if (b.goLiveNow !== undefined && typeof b.goLiveNow !== 'boolean') return res.status(400).json({ error: 'goLiveNow must be true or false' });
  const when = b.scheduledFor === undefined ? null : new Date(b.scheduledFor);
  if (when && (typeof b.scheduledFor !== 'string' || Number.isNaN(when.getTime()))) return res.status(400).json({ error: 'scheduledFor must be a date and time' });
  try {
    const live = b.goLiveNow === true;
    const r = await db.query(
      `insert into rooms (host_id, title, category, max_guests, status, scheduled_for, started_at)
       values ($1, $2, $3, $4, $5, $6, case when $5 = 'live' then now() end) returning *`,
      [req.user.id, title, category, maxGuests, live ? 'live' : 'scheduled', when]
    );
    const room = r.rows[0];
    if (live) await wentLive(room, req.user.id);
    res.status(201).json({ ...room, host_handle: req.user.handle, guest_count: 0 });
  } catch (err) { next(err); }
});

// POST /api/rooms/invite/:token — redeem a one-time invite (declared before /:id routes)
router.post('/invite/:token', requireAuth, async (req, res, next) => {
  const token = req.params.token;
  if (!isStr(token, 20, 100)) return res.status(404).json({ error: 'This invite link is not valid' });
  try {
    const out = await db.tx(async (client) => {
      const r = await client.query(
        `select i.*, i.expires_at < now() as expired, ro.status as room_status from room_invites i
         join rooms ro on ro.id = i.room_id where i.token_hash = $1 for update of i`,
        [sha256(token)]
      );
      const inv = r.rows[0];
      if (!inv) return { status: 404, error: 'This invite link is not valid' };
      if (inv.claimed_by && inv.claimed_by !== req.user.id) return { status: 410, error: 'This invite has already been used' };
      if (!inv.claimed_by && inv.expired) return { status: 410, error: 'This invite has expired' };
      if (inv.room_status === 'ended') return { status: 410, error: 'This stream has ended' };
      if (!inv.claimed_by) await client.query('update room_invites set claimed_by = $2, claimed_at = now() where token_hash = $1', [inv.token_hash, req.user.id]);
      await client.query(
        `insert into room_participants (room_id, user_id) values ($1, $2)
         on conflict (room_id, user_id) do update set left_at = null, joined_at = now()`,
        [inv.room_id, req.user.id]
      );
      return { roomId: inv.room_id };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, room: await loadRoom(out.roomId) });
  } catch (err) { next(err); }
});

// GET /api/rooms/:id
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const room = await loadRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  } catch (err) { next(err); }
});

async function hostRoom(req, res) {
  const room = await loadRoom(req.params.id);
  if (!room) { res.status(404).json({ error: 'Room not found' }); return null; }
  if (room.host_id !== req.user.id) { res.status(403).json({ error: 'Only the host can do that' }); return null; }
  return room;
}

// PATCH /api/rooms/:id   { status: live | ended }   host only
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const room = await hostRoom(req, res);
    if (!room) return;
    const { status } = req.body || {};
    if (!['live', 'ended'].includes(status)) return res.status(400).json({ error: 'status must be live or ended' });
    if (room.status === 'ended') return res.status(409).json({ error: 'This stream has already ended' });
    if (room.status === status) return res.json(room);
    const r = await db.query(
      `update rooms set status = $2,
         started_at = case when $2 = 'live' then now() else started_at end,
         ended_at = case when $2 = 'ended' then now() else ended_at end
       where id = $1 returning *`,
      [room.id, status]
    );
    if (status === 'live') await wentLive(r.rows[0], req.user.id);
    if (status === 'ended') {
      await db.query('update room_participants set left_at = coalesce(left_at, now()) where room_id = $1', [room.id]);
      realtime.roomEnded(room.id);
    }
    res.json({ ...r.rows[0], host_handle: room.host_handle });
  } catch (err) { next(err); }
});

// POST /api/rooms/:id/join — live rooms only; guests take a seat (the host never needs one)
router.post('/:id/join', requireAuth, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Room not found' });
  try {
    const out = await db.tx(async (client) => {
      const r = await client.query('select * from rooms where id = $1 for update', [req.params.id]);
      const room = r.rows[0];
      if (!room) return { status: 404, error: 'Room not found' };
      if (room.status !== 'live') return { status: 409, error: 'This room is not live' };
      if (room.host_id !== req.user.id) {
        const seated = await client.query('select 1 from room_participants where room_id = $1 and user_id = $2 and left_at is null', [room.id, req.user.id]);
        if (!seated.rows.length) {
          const n = await client.query('select count(*)::int as n from room_participants where room_id = $1 and left_at is null and user_id <> $2', [room.id, room.host_id]);
          if (n.rows[0].n >= room.max_guests) return { status: 409, error: 'This room is full' };
        }
      }
      await client.query(
        `insert into room_participants (room_id, user_id) values ($1, $2)
         on conflict (room_id, user_id) do update set left_at = null`,
        [room.id, req.user.id]
      );
      return { status: 200 };
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, room: await loadRoom(req.params.id) });
  } catch (err) { next(err); }
});

router.post('/:id/leave', requireAuth, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Room not found' });
  try {
    await db.query('update room_participants set left_at = now() where room_id = $1 and user_id = $2 and left_at is null', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/rooms/:id/invite — host only; a one-time link valid for 2 hours. Only its hash is stored.
router.post('/:id/invite', requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const room = await hostRoom(req, res);
    if (!room) return;
    if (room.status === 'ended') return res.status(409).json({ error: 'This stream has ended' });
    const token = crypto.randomBytes(24).toString('base64url');
    await db.query(
      `insert into room_invites (token_hash, room_id, created_by, expires_at)
       values ($1, $2, $3, now() + make_interval(mins => $4))`,
      [sha256(token), room.id, req.user.id, INVITE_MINUTES]
    );
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    res.status(201).json({ token, url: `${base}/join/${token}`, expiresInMinutes: INVITE_MINUTES });
  } catch (err) { next(err); }
});

// ---- watch party ----
router.get('/:id/watchparty', async (req, res, next) => {
  try {
    const room = await loadRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const [state, queue] = await Promise.all([
      db.query('select * from watchparty_state where room_id = $1', [room.id]),
      db.query('select * from watchparty_queue where room_id = $1 order by created_at, id', [room.id]),
    ]);
    res.json({ state: state.rows[0] || null, queue: queue.rows });
  } catch (err) { next(err); }
});

const videoInput = (b) => {
  const title = b.title === undefined ? '' : b.title;
  if (typeof b.youtubeId !== 'string' || !YT_RE.test(b.youtubeId)) return { error: 'youtubeId must be an 11-character YouTube video id' };
  if (!isStr(title, 0, 120)) return { error: 'title must be 120 characters or fewer' };
  return { youtubeId: b.youtubeId, title };
};

router.post('/:id/watchparty/load', requireAuth, async (req, res, next) => {
  try {
    const room = await hostRoom(req, res);
    if (!room) return;
    const v = videoInput(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const r = await db.query(
      `insert into watchparty_state (room_id, youtube_id, title, playing, updated_at) values ($1, $2, $3, true, now())
       on conflict (room_id) do update set youtube_id = $2, title = $3, playing = true, updated_at = now() returning *`,
      [room.id, v.youtubeId, v.title]
    );
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.post('/:id/watchparty/queue', requireAuth, writeLimiter, async (req, res, next) => {
  try {
    const room = await loadRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const v = videoInput(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const n = await db.query('select count(*)::int as n from watchparty_queue where room_id = $1', [room.id]);
    if (n.rows[0].n >= QUEUE_MAX) return res.status(409).json({ error: `The queue is full (${QUEUE_MAX} videos)` });
    const r = await db.query(
      'insert into watchparty_queue (room_id, youtube_id, title, added_by) values ($1, $2, $3, $4) returning *',
      [room.id, v.youtubeId, v.title, req.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.loadRoom = loadRoom;
