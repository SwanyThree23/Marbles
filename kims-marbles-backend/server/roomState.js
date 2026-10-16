// Server-owned control state per live room (layout, who is muted, whose camera is off).
// Every change bumps `version`; joiners and reconnecting devices get the whole snapshot, so
// a phone and a desktop opened at different times always converge. A repeated commandId (a
// double tap, a retried emit) is applied once. Per-process memory: see the scaling notes.
const rooms = new Map(); // roomId -> state
const MAX_REMEMBERED_COMMANDS = 200;

function get(roomId, hostId) {
  let s = rooms.get(roomId);
  if (!s) {
    s = { roomId, hostId, version: 0, layout: 'grid', muted: {}, cameraOff: {}, seen: new Map() };
    rooms.set(roomId, s);
  }
  return s;
}
const snapshot = (s) => ({ roomId: s.roomId, hostId: s.hostId, version: s.version, layout: s.layout, muted: { ...s.muted }, cameraOff: { ...s.cameraOff } });

const LAYOUTS = ['grid', 'spotlight'];
const UUID_RE = /^[0-9a-f-]{36}$/i;

// cmd: { type: 'layout'|'mute'|'camera', value, targetUserId?, commandId? }
function apply(roomId, hostId, cmd) {
  const s = get(roomId, hostId);
  if (typeof cmd.commandId === 'string' && cmd.commandId && s.seen.has(cmd.commandId)) {
    return { ok: true, duplicate: true, version: s.seen.get(cmd.commandId), state: snapshot(s) };
  }
  if (cmd.type === 'layout') {
    if (!LAYOUTS.includes(cmd.value)) return { ok: false, error: 'Unknown layout' };
    s.layout = cmd.value;
  } else if (cmd.type === 'mute' || cmd.type === 'camera') {
    if (typeof cmd.targetUserId !== 'string' || !UUID_RE.test(cmd.targetUserId) || typeof cmd.value !== 'boolean') return { ok: false, error: 'Bad command' };
    const map = cmd.type === 'mute' ? s.muted : s.cameraOff;
    if (cmd.value) map[cmd.targetUserId] = true; else delete map[cmd.targetUserId];
  } else {
    return { ok: false, error: 'Unknown command' };
  }
  s.version += 1;
  if (typeof cmd.commandId === 'string' && cmd.commandId) {
    s.seen.set(cmd.commandId.slice(0, 64), s.version);
    if (s.seen.size > MAX_REMEMBERED_COMMANDS) s.seen.delete(s.seen.keys().next().value);
  }
  return { ok: true, version: s.version, state: snapshot(s) };
}

const forget = (roomId) => rooms.delete(roomId);

module.exports = { get, snapshot, apply, forget };
