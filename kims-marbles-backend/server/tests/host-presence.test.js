// A live room whose host has gone (closed the tab, lost power, the server restarted and they
// never came back) ends by itself after a grace period, instead of staying "Live" forever.
// A host who comes back in time (a reconnect, a refresh, a second device) keeps it live.
const { test, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./setup');
const { startServer, stopServer, connect, closeSockets, waitFor, arrives, ack, register, rest } = require('./live-server');

const GRACE = 600;
let server;
before(async () => { server = await startServer({ HOST_GRACE_MS: String(GRACE) }); });
after(async () => { closeSockets(); await stopServer(server); await db.pool.end(); });
beforeEach(resetDb);
afterEach(closeSockets);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async (roomId) => (await db.query('select status from rooms where id = $1', [roomId])).rows[0].status;

async function liveRoom() {
  const host = await register(server, 'Host');
  const room = (await rest(server, host, 'POST', '/api/rooms', { title: 'Show', goLiveNow: true })).body;
  return { host, room };
}
async function inRoom(user, room) {
  const s = await connect(server, user?.token);
  const st = waitFor(s, 'room:state');
  s.emit('room:join', { roomId: room.id });
  await st;
  return s;
}

test('the host disconnects and does not come back: the room ends after the grace period and viewers are told', async () => {
  const { host, room } = await liveRoom();
  const hs = await inRoom(host, room);
  const viewer = await inRoom(await register(server, 'Viewer'), room);
  const ended = waitFor(viewer, 'room:ended', { ms: GRACE * 5 });
  hs.disconnect();
  await sleep(GRACE / 3);
  assert.equal(await status(room.id), 'live', 'not ended before the grace period');
  assert.deepEqual(await ended, { roomId: room.id });
  assert.equal(await status(room.id), 'ended');
  const r = await rest(server, host, 'GET', '/api/rooms?status=live');
  assert.equal(r.body.length, 0, 'no longer listed as live');
});

test('a host who reconnects within the grace period keeps the room live', async () => {
  const { host, room } = await liveRoom();
  const hs = await inRoom(host, room);
  hs.disconnect();
  await sleep(GRACE / 2);
  await inRoom(host, room);
  await sleep(GRACE * 1.5);
  assert.equal(await status(room.id), 'live');
});

test('the host joining over media only (ms:join) counts as present', async () => {
  const { host, room } = await liveRoom();
  const hs = await connect(server, host.token);
  assert.ok((await ack(hs, 'ms:join', { roomId: room.id })).rtpCapabilities);
  await sleep(GRACE * 2);
  assert.equal(await status(room.id), 'live');
});

test('a second device of the host keeps the room live when the first one goes', async () => {
  const { host, room } = await liveRoom();
  const phone = await inRoom(host, room);
  await inRoom(host, room);
  phone.disconnect();
  await sleep(GRACE * 2);
  assert.equal(await status(room.id), 'live');
});

test('guests coming and going never end the room, and a guest is not mistaken for the host', async () => {
  const { host, room } = await liveRoom();
  await inRoom(host, room);
  const g = await inRoom(await register(server, 'Guest'), room);
  g.disconnect();
  await sleep(GRACE * 2);
  assert.equal(await status(room.id), 'live');
});

test('a host who leaves the room on purpose (room:leave) but stays connected starts the same countdown', async () => {
  const { host, room } = await liveRoom();
  const hs = await inRoom(host, room);
  hs.emit('room:leave', { roomId: room.id });
  await sleep(GRACE * 3);
  assert.equal(await status(room.id), 'ended');
});

test('a room the host never joined at all (created, then the tab closed) ends too', async () => {
  const { room } = await liveRoom();
  const viewer = await inRoom(await register(server, 'Viewer'), room);
  assert.ok(await arrives(viewer, 'room:ended', GRACE * 4), 'viewer was never told');
  assert.equal(await status(room.id), 'ended');
});

// last: it replaces the shared server (two servers sweeping one database would race)
test('after a server restart, a live room whose host never reconnects is ended; one whose host does is kept', async () => {
  const { room } = await liveRoom();
  const other = await register(server, 'Other');
  const kept = (await rest(server, other, 'POST', '/api/rooms', { title: 'Kept', goLiveNow: true })).body;
  await stopServer(server);
  server = await startServer({ HOST_GRACE_MS: String(GRACE) });
  const os = await connect(server, other.token);
  const st = waitFor(os, 'room:state');
  os.emit('room:join', { roomId: kept.id });
  await st;
  await sleep(GRACE * 3);
  assert.equal(await status(room.id), 'ended', 'abandoned room still live after a restart');
  assert.equal(await status(kept.id), 'live');
});
