// socketGuard.js — the safety rails every Socket.io handler runs inside.
//
// Why this exists: Socket.io does NOT catch exceptions thrown inside event
// handlers, and a handler like `({ roomId }) => ...` throws if a client sends
// the event with no payload. One packet from an anonymous client could crash
// the whole process (and drop every live room). Everything a client sends is
// untrusted input.
const db = require('./db');

const YOUTUBE_ID_RE = /^[\w-]{11}$/;

const { isUuid } = require('./validate');
const isYoutubeId = (v) => typeof v === 'string' && YOUTUBE_ID_RE.test(v);
// non-empty string no longer than `max`
const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

// Wraps a handler so that it (1) always receives an object payload, never
// undefined/array/primitive, (2) can never throw or reject out into Node, and
// (3) always has an ack function when `ack: true` (so `ack(...)` can't throw).
function guard(handler, { ack = false } = {}) {
  return (...args) => {
    const last = args[args.length - 1];
    let cb = typeof last === 'function' ? last : undefined;
    const raw = args[0];
    const payload = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (ack && !cb) cb = () => {};

    const fail = (err) => {
      console.error('[socket handler]', err);
      try { if (cb) cb({ error: 'Something went wrong' }); } catch (_e) { /* ack itself failed */ }
    };
    try {
      const out = handler(payload, cb);
      if (out && typeof out.catch === 'function') out.catch(fail);
    } catch (err) {
      fail(err);
    }
  };
}

// ---- who is the host of a room? (a room's host never changes, so cache it) ----
const hostCache = new Map(); // roomId -> hostId
const CACHE_MAX = 5000;
function remember(map, key, value) {
  map.set(key, value);
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

async function isRoomHost(userId, roomId) {
  if (!userId || !isUuid(roomId)) return false;
  let hostId = hostCache.get(roomId);
  if (hostId === undefined) {
    const r = await db.query('select host_id from rooms where id = $1', [roomId]);
    hostId = r.rows[0]?.host_id;
    if (!hostId) return false; // never cache "not found"
    remember(hostCache, roomId, hostId);
  }
  return hostId === userId;
}

// ---- does this room exist and is it still open? (short positive cache) ----
const openCache = new Map(); // roomId -> expiresAt
const OPEN_TTL_MS = 15_000;
async function roomIsOpen(roomId) {
  if (!isUuid(roomId)) return false;
  const until = openCache.get(roomId);
  if (until && until > Date.now()) return true;
  const r = await db.query("select 1 from rooms where id = $1 and status <> 'ended'", [roomId]);
  if (!r.rows.length) { openCache.delete(roomId); return false; }
  remember(openCache, roomId, Date.now() + OPEN_TTL_MS);
  return true;
}

// ---- live-chat moderation ----
const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word, case-insensitive match, so blocking "ass" doesn't also block
// "class" or "assist". Words made of symbols/emoji (":)", "http://") can't have
// word boundaries, so those match as plain substrings. Returns the matched
// blocked word, or null. (It does not defeat deliberate obfuscation like "b@d".)
function findBlockedWord(text, words) {
  if (!text || !words || !words.length) return null;
  const hay = text.toLowerCase();
  for (const word of words) {
    const needle = String(word).toLowerCase();
    if (!needle) continue;
    if (/^[\p{L}\p{N}_' -]+$/u.test(needle)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`, 'u');
      if (re.test(hay)) return word;
    } else if (hay.includes(needle)) {
      return word;
    }
  }
  return null;
}

// roomId -> { hostId, enabled, words, until }. Short TTL so a list edited on
// another server process still takes effect within seconds; edits made through
// this process invalidate immediately.
const moderationCache = new Map();
const MODERATION_TTL_MS = 10_000;
async function getRoomModeration(roomId) {
  if (!isUuid(roomId)) return null;
  const hit = moderationCache.get(roomId);
  if (hit && hit.until > Date.now()) return hit;
  const r = await db.query(
    `select r.host_id, coalesce(m.enabled, false) as enabled, coalesce(m.words, '{}') as words
     from rooms r left join moderation_settings m on m.user_id = r.host_id
     where r.id = $1`,
    [roomId]
  );
  if (!r.rows.length) return null;
  const entry = { hostId: r.rows[0].host_id, enabled: r.rows[0].enabled, words: r.rows[0].words, until: Date.now() + MODERATION_TTL_MS };
  remember(moderationCache, roomId, entry);
  return entry;
}
function invalidateModeration(hostId) {
  for (const [roomId, entry] of moderationCache) if (entry.hostId === hostId) moderationCache.delete(roomId);
}

// ---- flood protection: token buckets ----
// Anyone connected could otherwise send chat / reactions / commands at machine speed to a
// whole room (or open many sockets to multiply their budget). A bucket holds up to `burst`
// tokens and refills at `perSec`; each event costs one. Per-process memory, like the rest of
// the real-time state (see the scaling notes in DEPLOY.md).
const buckets = new Map(); // key -> { tokens, at }
function takeToken(key, { burst, perSec }, now = Date.now()) {
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, at: now }; buckets.set(key, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
  b.at = now;
  if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryMs: 0 }; }
  return { ok: false, retryMs: Math.ceil(((1 - b.tokens) / perSec) * 1000) };
}
function resetBuckets() { buckets.clear(); }
setInterval(() => { // forget buckets nobody has touched for a while
  const cutoff = Date.now() - 120_000;
  for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
}, 60_000).unref();

// A logged-in user has ONE budget however many sockets they open; an anonymous socket has its own.
const limitKey = (socket, name) => `${socket.user ? `u:${socket.user.id}` : `s:${socket.id}`}:${name}`;

// Wraps a handler: under the limit it runs; over it, `onLimit(retryMs, payload, ack)` runs instead.
function limited(socket, name, rule, handler, onLimit) {
  return (payload, ack) => {
    const r = takeToken(limitKey(socket, name), rule);
    if (!r.ok) { if (onLimit) onLimit(r.retryMs, payload, ack); return undefined; }
    return handler(payload, ack);
  };
}

// is this socket currently a member of the Socket.io room?
const inRoom = (socket, roomId) => typeof roomId === 'string' && socket.rooms.has(roomId);

module.exports = { takeToken, resetBuckets, limited, guard, isUuid, isYoutubeId, isStr, isRoomHost, roomIsOpen, inRoom, findBlockedWord, getRoomModeration, invalidateModeration };
