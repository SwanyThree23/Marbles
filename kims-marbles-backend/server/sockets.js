// Socket.io handlers: rooms, chat (moderated, flood-limited), reactions, host commands,
// watch party, battles, the per-user channel (settings sync, device list) and the SFU.
// Every handler runs inside guard() (never throws, payload is always an object) and every
// client-driven event inside a token bucket (see socketGuard.js).
const crypto = require('crypto');
const db = require('./db');
const { verifyAccessToken } = require('./middleware/auth');
const {
  guard, limited, takeToken, isUuid, isYoutubeId, isRoomHost, roomIsOpen, inRoom,
  findBlockedWord, getRoomModeration,
} = require('./socketGuard');
const roomState = require('./roomState');
const signaling = require('./mediasoup/signaling');
const presence = require('./hostPresence');

const RULES = {
  chat: { burst: 5, perSec: 1 },
  reaction: { burst: 8, perSec: 4 },
  command: { burst: 10, perSec: 5 },
  watchparty: { burst: 6, perSec: 2 },
  join: { burst: 5, perSec: 1 },
  device: { burst: 3, perSec: 0.2 },
  settings: { burst: 10, perSec: 2 },
};
const CONNECTION_RULE = { burst: 150, perSec: 50 }; // any events at all; beyond this a client is flooding
const SETTINGS = { theme: ['light', 'dark', 'system'] };
const MAX_DEVICES = 25;
const devices = new Map(); // userId -> Map<socketId, { deviceId, label, connectedAt }>

function deviceList(userId) {
  return [...(devices.get(userId)?.values() || [])].map(({ deviceId, label, connectedAt }) => ({ deviceId, label, connectedAt }));
}

function register(io) {
  // Optional login: no token = anonymous viewer. A token that fails is refused, so the client
  // knows to refresh it (its auth callback fetches a fresh one on reconnect).
  io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next();
    try {
      const claims = verifyAccessToken(token);
      const r = await db.query('select id, handle, is_admin, banned_at from users where id = $1', [claims.sub]);
      if (!r.rows[0] || r.rows[0].banned_at) return next(new Error('unauthorized'));
      socket.user = r.rows[0];
      next();
    } catch (_e) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user || null;
    if (user) socket.join(`user:${user.id}`);

    socket.use((_packet, next) => {
      if (!takeToken(`conn:${socket.id}`, CONNECTION_RULE).ok) { socket.disconnect(true); return; }
      next();
    });
    const slowAck = (_ms, _p, ack) => { if (typeof ack === 'function') ack({ ok: false, error: 'Slow down' }); };

    // ---------------- rooms ----------------
    socket.on('room:join', limited(socket, 'join', RULES.join, guard(async ({ roomId }) => {
      if (!isUuid(roomId) || !(await roomIsOpen(roomId))) return;
      const mod = await getRoomModeration(roomId);
      if (!mod) return;
      socket.join(roomId);
      if (user && user.id === mod.hostId) presence.hostJoined(roomId, socket.id);
      socket.emit('room:state', roomState.snapshot(roomState.get(roomId, mod.hostId)));
      if (user) socket.to(roomId).emit('room:guest-joined', { userId: user.id, handle: user.handle });
    })));

    socket.on('room:leave', guard(({ roomId }) => {
      if (typeof roomId !== 'string') return;
      socket.leave(roomId);
      presence.hostLeft(roomId, socket.id);
    }));

    socket.on('room:chat', limited(socket, 'chat', RULES.chat, guard(async ({ roomId, text }) => {
      if (!user || !inRoom(socket, roomId) || typeof text !== 'string') return;
      const body = text.trim();
      if (!body || body.length > 500) return;
      const mod = await getRoomModeration(roomId);
      if (!mod) return;
      if (mod.enabled && user.id !== mod.hostId) {
        const word = findBlockedWord(body, mod.words);
        if (word) {
          socket.emit('room:chat:blocked', { roomId, reason: "This message breaks the host's chat rules" });
          io.to(`user:${mod.hostId}`).emit('moderation:flagged', { roomId, userId: user.id, handle: user.handle, text: body, word, at: new Date().toISOString() });
          return;
        }
      }
      // Broadcast first, in arrival order; history is saved in the background. (Awaiting the
      // insert before broadcasting let messages overtake each other.)
      const at = new Date();
      io.to(roomId).emit('room:chat', { id: crypto.randomUUID(), roomId, userId: user.id, handle: user.handle, text: body, at: at.toISOString() });
      db.query('insert into room_chat (room_id, user_id, text, created_at) values ($1, $2, $3, $4)', [roomId, user.id, body, at])
        .catch((err) => console.error('[room:chat] could not save history', err.message));
    }), (retryMs, payload) => socket.emit('room:chat:throttled', { roomId: payload?.roomId, retryMs })));

    socket.on('room:reaction', limited(socket, 'reaction', RULES.reaction, guard(({ roomId, emoji }) => {
      if (!inRoom(socket, roomId) || typeof emoji !== 'string' || emoji.length > 8 || !/\p{Extended_Pictographic}/u.test(emoji)) return;
      io.to(roomId).emit('room:reaction', { roomId, emoji, userId: user?.id || null });
    })));

    socket.on('room:command', limited(socket, 'command', RULES.command, guard(async (cmd, ack) => {
      const { roomId } = cmd;
      if (!user) return ack({ ok: false, error: 'Log in first' });
      if (!isUuid(roomId) || !(await isRoomHost(user.id, roomId))) return ack({ ok: false, error: 'Only the host can do that' });
      const r = roomState.apply(roomId, user.id, cmd);
      if (!r.ok) return ack({ ok: false, error: r.error });
      if (!r.duplicate) io.to(roomId).emit('room:state', r.state);
      ack({ ok: true, version: r.version, ...(r.duplicate ? { duplicate: true } : {}) });
    }, { ack: true }), slowAck));

    socket.on('room:screen-share', guard(({ roomId, active }) => {
      if (!inRoom(socket, roomId) || typeof active !== 'boolean') return;
      socket.to(roomId).emit('room:screen-share', { roomId, userId: user?.id || null, handle: user?.handle || 'Viewer', active });
    }));

    // ---------------- watch party (host only) ----------------
    socket.on('watchparty:load', limited(socket, 'watchparty', RULES.watchparty, guard(async ({ roomId, youtubeId, title }) => {
      if (!user || !isYoutubeId(youtubeId) || !(await isRoomHost(user.id, roomId))) return;
      socket.to(roomId).emit('watchparty:load', { roomId, youtubeId, title: typeof title === 'string' ? title.slice(0, 120) : '' });
    })));
    // The room's playback clock lives in watchparty_state. Every change carries the host's real
    // player position; heartbeats (watchparty:sync) correct drift. Others get the same values.
    const position = (p) => (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 86_400 ? p : null);
    socket.on('watchparty:control', limited(socket, 'watchparty', RULES.watchparty, guard(async ({ roomId, action, position: p }) => {
      if (!user || !['play', 'pause', 'seek', 'restart'].includes(action) || !(await isRoomHost(user.id, roomId))) return;
      const pos = action === 'restart' ? 0 : position(p);
      if (pos === null) return;
      const r = await db.query(
        `update watchparty_state set position_seconds = $2, updated_at = now(),
           playing = case $3 when 'play' then true when 'restart' then true when 'pause' then false else playing end
         where room_id = $1 returning playing`,
        [roomId, pos, action]
      );
      if (!r.rows[0]) return;
      socket.to(roomId).emit('watchparty:control', { roomId, action, position: pos, playing: r.rows[0].playing });
    })));
    socket.on('watchparty:sync', limited(socket, 'watchparty', RULES.watchparty, guard(async ({ roomId, position: p }) => {
      const pos = position(p);
      if (!user || pos === null || !(await isRoomHost(user.id, roomId))) return;
      const r = await db.query(
        'update watchparty_state set position_seconds = $2, updated_at = now() where room_id = $1 and playing returning playing', [roomId, pos]
      );
      if (r.rows[0]) socket.to(roomId).emit('watchparty:sync', { roomId, position: pos, playing: true });
    })));

    // ---------------- battles (gifts arrive over REST and are pushed from there) ----------------
    socket.on('battle:join', limited(socket, 'join', RULES.join, guard(({ battleId }) => {
      if (isUuid(battleId)) socket.join(`battle:${battleId}`);
    })));
    socket.on('battle:leave', guard(({ battleId }) => { if (isUuid(battleId)) socket.leave(`battle:${battleId}`); }));

    // ---------------- my devices ----------------
    socket.on('settings:sync', limited(socket, 'settings', RULES.settings, guard(({ key, value }) => {
      if (!user || !Object.hasOwn(SETTINGS, key) || !SETTINGS[key].includes(value)) return;
      socket.to(`user:${user.id}`).emit('settings:sync', { key, value });
    })));

    socket.on('device:register', limited(socket, 'device', RULES.device, guard(({ deviceId, label }) => {
      if (!user || typeof deviceId !== 'string' || !deviceId || deviceId.length > 64 || typeof label !== 'string' || !label || label.length > 40) return;
      if (!devices.has(user.id)) devices.set(user.id, new Map());
      const mine = devices.get(user.id);
      if (!mine.has(socket.id) && mine.size >= MAX_DEVICES) return;
      mine.set(socket.id, { deviceId, label, connectedAt: new Date().toISOString() });
      io.to(`user:${user.id}`).emit('device:list', deviceList(user.id));
    })));

    // ---------------- media ----------------
    signaling.register(io, socket);

    socket.on('disconnect', () => {
      if (socket.data.msLeave) socket.data.msLeave();
      presence.socketGone(socket.id);
      if (user && devices.get(user.id)?.delete(socket.id)) {
        if (!devices.get(user.id).size) devices.delete(user.id);
        io.to(`user:${user.id}`).emit('device:list', deviceList(user.id));
      }
    });
  });
}

const stats = () => ({ usersWithDevices: devices.size });

module.exports = { register, stats, RULES };
