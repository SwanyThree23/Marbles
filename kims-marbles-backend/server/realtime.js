// The one place REST routes reach live sockets. Before index.js registers Socket.io (e.g. in
// the REST test suite) every call is a harmless no-op.
let io = null;
const setIo = (server) => { io = server; };
const toUser = (userId, event, payload) => { if (io) io.to(`user:${userId}`).emit(event, payload); };
const toRoom = (room, event, payload) => { if (io) io.to(room).emit(event, payload); };
const disconnectUser = (userId) => { if (io) io.in(`user:${userId}`).disconnectSockets(true); };

// A room ended over REST: everything live about it stops now. index.js adds the SFU cleanup.
const roomEndedHooks = [];
const onRoomEnded = (fn) => roomEndedHooks.push(fn);
function roomEnded(roomId) {
  for (const fn of roomEndedHooks) { try { fn(roomId); } catch (err) { console.error('[realtime] roomEnded hook', err); } }
  toRoom(roomId, 'room:ended', { roomId });
}

module.exports = { setIo, toUser, toRoom, disconnectUser, onRoomEnded, roomEnded };
