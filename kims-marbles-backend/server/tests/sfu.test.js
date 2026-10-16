// MediaSoup signalling through the REAL server and a real mediasoup worker. Producers are
// created from hand-written RTP parameters (no browser), which is enough to prove the rules;
// real media flowing is proven by the real-browser suite.
const { test, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./setup');
const { startServer, stopServer, connect, closeSockets, waitFor, arrives, ack, register, rest } = require('./live-server');

let server;
before(async () => { server = await startServer(); });
after(async () => { closeSockets(); await stopServer(server); await db.pool.end(); });
beforeEach(resetDb);
afterEach(closeSockets);

const OPUS = (ssrc) => ({ codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }], encodings: [{ ssrc }] });
const VP8 = (ssrc) => ({ codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }], encodings: [{ ssrc }] });
let ssrc = 1000;

async function liveRoom() {
  const host = await register(server, 'Host');
  const room = (await rest(server, host, 'POST', '/api/rooms', { title: 'Live', goLiveNow: true })).body;
  return { host, room };
}
async function peer(user, room) {
  const s = await connect(server, user?.token);
  const j = await ack(s, 'ms:join', { roomId: room.id });
  assert.ok(j.rtpCapabilities, `ms:join failed: ${JSON.stringify(j)}`);
  s.caps = j.rtpCapabilities;
  s.existing = j.existingProducers;
  return s;
}
async function sendTransport(s, room) {
  return ack(s, 'ms:create-transport', { roomId: room.id, direction: 'send' });
}
async function produce(s, room, kind = 'audio', source = kind === 'audio' ? 'audio' : 'video', extra = {}) {
  const t = s.sendT || (s.sendT = await sendTransport(s, room));
  return ack(s, 'ms:produce', { transportId: t.id, kind, rtpParameters: kind === 'audio' ? OPUS(ssrc++) : VP8(ssrc++), appData: { source, ...extra } });
}

test('ms:join: real open rooms only; anyone may watch; returns router capabilities', async () => {
  const { host, room } = await liveRoom();
  const anon = await connect(server);
  assert.ok((await ack(anon, 'ms:join', { roomId: '00000000-0000-0000-0000-000000000000' })).error);
  assert.ok((await ack(anon, 'ms:join', { roomId: 'nope' })).error);
  const j = await ack(anon, 'ms:join', { roomId: room.id });
  assert.ok(j.rtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus'));
  assert.ok(j.rtpCapabilities.codecs.some((c) => c.mimeType === 'video/VP8'));
  assert.deepEqual(j.existingProducers, []);
  await rest(server, host, 'PATCH', `/api/rooms/${room.id}`, { status: 'ended' });
  const late = await connect(server);
  assert.ok((await ack(late, 'ms:join', { roomId: room.id })).error, 'no router for an ended room');
});

test('ms:join also joins the chat room (a client that only uses ms:join still gets room events)', async () => {
  const { host, room } = await liveRoom();
  const viewer = await peer(await register(server, 'Viewer'), room);
  const hs = await peer(host, room);
  const got = waitFor(viewer, 'room:chat');
  hs.emit('room:chat', { roomId: room.id, text: 'can you hear me' });
  assert.equal((await got).text, 'can you hear me');
});

test('transports: viewers get receive transports; sending needs a login; at most 4 per peer', async () => {
  const { room } = await liveRoom();
  const anon = await peer(null, room);
  assert.ok((await ack(anon, 'ms:create-transport', { roomId: room.id, direction: 'send' })).error);
  const recv = await ack(anon, 'ms:create-transport', { roomId: room.id, direction: 'recv' });
  assert.ok(recv.id && recv.iceParameters && recv.dtlsParameters);
  assert.ok(recv.iceCandidates.every((c) => c.address === '127.0.0.1'), 'announced address is used');
  assert.ok((await ack(anon, 'ms:create-transport', { roomId: room.id, direction: 'sideways' })).error);
  for (let i = 0; i < 3; i++) assert.ok((await ack(anon, 'ms:create-transport', { roomId: room.id, direction: 'recv' })).id);
  assert.ok((await ack(anon, 'ms:create-transport', { roomId: room.id, direction: 'recv' })).error, 'fifth transport refused');
});

test('produce: the source tag must match the kind; others are told who published what', async () => {
  const { host, room } = await liveRoom();
  const hs = await peer(host, room);
  const viewer = await peer(null, room);
  assert.ok((await produce(hs, room, 'audio', 'screen')).error, 'audio cannot claim to be a screen');
  assert.ok((await produce(hs, room, 'video', 'audio')).error);
  assert.ok((await produce(hs, room, 'audio', 'hologram')).error);
  const announced = waitFor(viewer, 'ms:new-producer');
  const p = await produce(hs, room, 'video', 'screen');
  assert.ok(p.id, JSON.stringify(p));
  const a = await announced;
  assert.deepEqual([a.producerId, a.userId, a.handle, a.source, a.kind], [p.id, host.id, 'Host', 'screen', 'video']);
  const late = await peer(null, room);
  assert.deepEqual(late.existing.map((x) => [x.producerId, x.source]), [[p.id, 'screen']], 'a late joiner learns existing producers');
});

test('produce: at most 3 producers per peer', async () => {
  const { host, room } = await liveRoom();
  const hs = await peer(host, room);
  assert.ok((await produce(hs, room, 'audio')).id);
  assert.ok((await produce(hs, room, 'video', 'video')).id);
  assert.ok((await produce(hs, room, 'video', 'screen')).id);
  assert.ok((await produce(hs, room, 'audio')).error);
});

test('consume: a viewer can consume a producer (starts paused) and resume it', async () => {
  const { host, room } = await liveRoom();
  const hs = await peer(host, room);
  const p = await produce(hs, room, 'audio');
  const viewer = await peer(null, room);
  const t = await ack(viewer, 'ms:create-transport', { roomId: room.id, direction: 'recv' });
  const c = await ack(viewer, 'ms:consume', { transportId: t.id, producerId: p.id, rtpCapabilities: viewer.caps });
  assert.ok(c.id, JSON.stringify(c));
  assert.equal(c.producerId, p.id);
  assert.equal(c.kind, 'audio');
  assert.equal(c.paused, true);
  assert.deepEqual(await ack(viewer, 'ms:resume-consumer', { consumerId: c.id }), { ok: true });
  assert.ok((await ack(viewer, 'ms:consume', { transportId: t.id, producerId: 'nope', rtpCapabilities: viewer.caps })).error);
});

test('when a publisher leaves or disconnects, everyone is told their producers closed', async () => {
  const { host, room } = await liveRoom();
  const hs = await peer(host, room);
  const p = await produce(hs, room, 'audio');
  const viewer = await peer(null, room);
  const closed = waitFor(viewer, 'ms:producer-closed');
  hs.disconnect();
  assert.equal((await closed).producerId, p.id);
});

test('close-producer: only your own', async () => {
  const { host, room } = await liveRoom();
  const hs = await peer(host, room);
  const p = await produce(hs, room, 'audio');
  const other = await peer(await register(server, 'Other'), room);
  assert.ok((await ack(other, 'ms:close-producer', { producerId: p.id })).error);
  const closed = waitFor(other, 'ms:producer-closed');
  assert.deepEqual(await ack(hs, 'ms:close-producer', { producerId: p.id }), { ok: true });
  assert.equal((await closed).producerId, p.id);
});

test('one publishing device per person per room: a second device is refused unless it takes over', async () => {
  const { host, room } = await liveRoom();
  const desk = await peer(host, room);
  const viewer = await peer(null, room);
  const deskCam = await produce(desk, room, 'video', 'video');
  const phone = await peer(host, room);
  const refused = await produce(phone, room, 'video', 'video');
  assert.equal(refused.error, 'publishing-elsewhere');
  const replaced = waitFor(desk, 'ms:publisher-replaced');
  const closed = waitFor(viewer, 'ms:producer-closed', { pred: (x) => x.producerId === deskCam.id });
  const taken = await produce(phone, room, 'video', 'video', { takeover: true });
  assert.ok(taken.id);
  assert.equal((await replaced).roomId, room.id);
  assert.ok(await closed, "the desk's old camera is closed for viewers");
  assert.equal((await produce(desk, room, 'audio')).error, 'publishing-elsewhere', 'the desk is now a controller only');
  assert.equal((await ack(desk, 'room:command', { roomId: room.id, type: 'layout', value: 'spotlight' })).ok, true, 'but keeps host controls');
  // a different person is never blocked by this rule
  const guest = await peer(await register(server, 'Guest'), room);
  assert.ok((await produce(guest, room, 'audio')).id);
  assert.equal(await arrives(viewer, 'ms:publisher-replaced', 300), false);
});
