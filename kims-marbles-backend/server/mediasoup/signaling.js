// MediaSoup signalling over Socket.io (ack-callback style, one call per step):
//   ms:join -> ms:create-transport -> ms:connect-transport -> ms:produce / ms:consume
//   -> ms:resume-consumer, ms:close-producer, ms:leave
// Events to clients: ms:new-producer, ms:producer-closed, ms:publisher-replaced.
//
// One publishing device per person per room: a second device of the same account is a
// controller (host controls + chat) and cannot publish unless it explicitly takes over,
// which closes the first device's media. This stops a host with phone + laptop open from
// sending two cameras.
const { guard, limited, isUuid, roomIsOpen, getRoomModeration } = require('../socketGuard');
const presence = require('../hostPresence');
const msRooms = require('./rooms');

const MAX_TRANSPORTS = 4;
const MAX_PRODUCERS = 3;
const SOURCES = { audio: ['audio'], video: ['video', 'screen'] };
const leases = new Map(); // `${roomId}:${userId}` -> socketId of the device allowed to publish
const leaseKey = (roomId, userId) => `${roomId}:${userId}`;

function releaseLeaseIfIdle(roomId, peer) {
  if (!peer.userId || peer.producers.size) return;
  const k = leaseKey(roomId, peer.userId);
  if (leases.get(k) === peer.socketId) leases.delete(k);
}

function register(io, socket) {
  const current = () => {
    const roomId = socket.data.msRoomId;
    const room = roomId && msRooms.getRoom(roomId);
    const peer = room && room.peers.get(socket.id);
    return peer ? { roomId, room, peer } : null;
  };

  function leave() {
    const roomId = socket.data.msRoomId;
    if (!roomId) return;
    const room = msRooms.getRoom(roomId);
    const peer = room && room.peers.get(socket.id);
    if (peer?.userId && leases.get(leaseKey(roomId, peer.userId)) === socket.id) leases.delete(leaseKey(roomId, peer.userId));
    for (const p of msRooms.removePeer(roomId, socket.id)) socket.to(roomId).emit('ms:producer-closed', p);
    socket.data.msRoomId = null;
  }
  socket.data.msLeave = leave;

  const JOIN_RULE = { burst: 5, perSec: 1 };
  socket.on('ms:join', limited(socket, 'join', JOIN_RULE, guard(async ({ roomId }, ack) => {
    if (!isUuid(roomId) || !(await roomIsOpen(roomId))) return ack({ error: 'This room is not live' });
    if (socket.data.msRoomId && socket.data.msRoomId !== roomId) leave();
    const room = await msRooms.getOrCreateRoom(roomId);
    if (!room.peers.has(socket.id)) msRooms.addPeer(room, socket);
    socket.data.msRoomId = roomId;
    socket.join(roomId);
    const mod = await getRoomModeration(roomId);
    if (mod && socket.user && socket.user.id === mod.hostId) presence.hostJoined(roomId, socket.id);
    const existingProducers = [];
    for (const other of room.peers.values()) {
      if (other.socketId === socket.id) continue;
      for (const p of other.producers.values()) {
        existingProducers.push({ producerId: p.id, userId: other.userId, handle: other.handle, source: p.appData.source, kind: p.kind });
      }
    }
    ack({ rtpCapabilities: room.router.rtpCapabilities, existingProducers });
  }, { ack: true }), (_ms, _p, ack) => typeof ack === 'function' && ack({ error: 'Slow down' })));

  socket.on('ms:create-transport', guard(async ({ direction }, ack) => {
    const c = current();
    if (!c) return ack({ error: 'Join the room first' });
    if (!['send', 'recv'].includes(direction)) return ack({ error: 'direction must be send or recv' });
    if (direction === 'send' && !socket.user) return ack({ error: 'Log in to publish' });
    if (c.peer.transports.size >= MAX_TRANSPORTS) return ack({ error: 'Too many transports' });
    const transport = await c.room.router.createWebRtcTransport({
      webRtcServer: c.room.webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000, appData: { direction },
    });
    c.peer.transports.set(transport.id, transport);
    transport.on('dtlsstatechange', (state) => { if (state === 'closed' || state === 'failed') transport.close(); });
    transport.observer.on('close', () => c.peer.transports.delete(transport.id));
    ack({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
  }, { ack: true }));

  socket.on('ms:connect-transport', guard(async ({ transportId, dtlsParameters }, ack) => {
    const t = current()?.peer.transports.get(transportId);
    if (!t) return ack({ error: 'Unknown transport' });
    await t.connect({ dtlsParameters });
    ack({ ok: true });
  }, { ack: true }));

  socket.on('ms:produce', guard(async ({ transportId, kind, rtpParameters, appData }, ack) => {
    const c = current();
    if (!c) return ack({ error: 'Join the room first' });
    if (!socket.user) return ack({ error: 'Log in to publish' });
    const t = c.peer.transports.get(transportId);
    if (!t || t.appData.direction !== 'send') return ack({ error: 'Unknown send transport' });
    const source = appData && appData.source;
    if (!SOURCES[kind] || !SOURCES[kind].includes(source)) return ack({ error: 'source must match kind (audio: audio; video: video or screen)' });
    if (c.peer.producers.size >= MAX_PRODUCERS) return ack({ error: 'Too many producers' });

    const k = leaseKey(c.roomId, socket.user.id);
    const holder = leases.get(k);
    if (holder && holder !== socket.id) {
      if (!(appData && appData.takeover === true)) return ack({ error: 'publishing-elsewhere' });
      const old = c.room.peers.get(holder);
      if (old) {
        for (const p of old.producers.values()) {
          p.close();
          io.to(c.roomId).emit('ms:producer-closed', { producerId: p.id, userId: old.userId });
        }
        old.producers.clear();
      }
      io.to(holder).emit('ms:publisher-replaced', { roomId: c.roomId });
    }
    let producer;
    try {
      producer = await t.produce({ kind, rtpParameters, appData: { source, userId: socket.user.id } });
    } catch (_err) {
      return ack({ error: 'Could not publish this media' });
    }
    leases.set(k, socket.id);
    c.peer.producers.set(producer.id, producer);
    producer.observer.on('close', () => { c.peer.producers.delete(producer.id); releaseLeaseIfIdle(c.roomId, c.peer); });
    socket.to(c.roomId).emit('ms:new-producer', { producerId: producer.id, userId: socket.user.id, handle: socket.user.handle, source, kind });
    ack({ id: producer.id });
  }, { ack: true }));

  socket.on('ms:consume', guard(async ({ transportId, producerId, rtpCapabilities }, ack) => {
    const c = current();
    if (!c) return ack({ error: 'Join the room first' });
    const t = c.peer.transports.get(transportId);
    if (!t || t.appData.direction !== 'recv') return ack({ error: 'Unknown receive transport' });
    if (typeof producerId !== 'string' || !c.room.router.canConsume({ producerId, rtpCapabilities })) return ack({ error: 'Cannot consume that producer' });
    const consumer = await t.consume({ producerId, rtpCapabilities, paused: true });
    c.peer.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => c.peer.consumers.delete(consumer.id));
    ack({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, paused: consumer.paused, appData: consumer.appData });
  }, { ack: true }));

  socket.on('ms:resume-consumer', guard(async ({ consumerId }, ack) => {
    const consumer = current()?.peer.consumers.get(consumerId);
    if (!consumer) return ack({ error: 'Unknown consumer' });
    await consumer.resume();
    ack({ ok: true });
  }, { ack: true }));

  socket.on('ms:close-producer', guard(async ({ producerId }, ack) => {
    const c = current();
    const p = c?.peer.producers.get(producerId);
    if (!p) return ack({ error: 'Not your producer' });
    p.close();
    io.to(c.roomId).emit('ms:producer-closed', { producerId, userId: c.peer.userId });
    ack({ ok: true });
  }, { ack: true }));

  socket.on('ms:leave', guard(async (_p, ack) => { leave(); ack({ ok: true }); }, { ack: true }));
}

const stats = () => ({ publisherLeases: leases.size, ...msRooms.stats() });

module.exports = { register, stats };
