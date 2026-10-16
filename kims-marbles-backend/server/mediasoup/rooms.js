// One mediasoup Router per live room, created on first join and closed when the last peer
// leaves. A peer is one socket in one room.
const { MEDIA_CODECS, nextWorker } = require('./worker');

const rooms = new Map(); // roomId -> { router, webRtcServer, peers: Map<socketId, peer> }
const creating = new Map(); // roomId -> Promise (two first-joiners at once share one router)

async function getOrCreateRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  if (!creating.has(roomId)) {
    creating.set(roomId, (async () => {
      const { worker, webRtcServer } = nextWorker();
      const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
      const room = { id: roomId, router, webRtcServer, peers: new Map() };
      rooms.set(roomId, room);
      return room;
    })().finally(() => creating.delete(roomId)));
  }
  return creating.get(roomId);
}

const getRoom = (roomId) => rooms.get(roomId) || null;

function addPeer(room, socket) {
  const peer = {
    socketId: socket.id, userId: socket.user?.id || null, handle: socket.user?.handle || 'Viewer',
    transports: new Map(), producers: new Map(), consumers: new Map(),
  };
  room.peers.set(socket.id, peer);
  return peer;
}

// Closes everything the peer owned; returns the producers that were closed.
function removePeer(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const peer = room.peers.get(socketId);
  if (!peer) return [];
  const closed = [...peer.producers.values()].map((p) => ({ producerId: p.id, userId: peer.userId }));
  for (const t of peer.transports.values()) t.close();
  room.peers.delete(socketId);
  if (!room.peers.size) {
    room.router.close();
    rooms.delete(roomId);
  }
  return closed;
}

function closeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.router.close();
  rooms.delete(roomId);
}

const stats = () => {
  let peers = 0; let producers = 0; let consumers = 0;
  for (const r of rooms.values()) for (const p of r.peers.values()) { peers++; producers += p.producers.size; consumers += p.consumers.size; }
  return { rooms: rooms.size, peers, producers, consumers };
};

module.exports = { getOrCreateRoom, getRoom, addPeer, removePeer, closeRoom, stats };
