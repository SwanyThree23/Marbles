// Watch-party sync: the server keeps the room's playback clock (position + playing + when),
// moved only by the host. Late joiners compute where the video is now; viewers get every
// change with the host's real position, plus periodic heartbeats to correct drift.
const { test, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./setup');
const { startServer, stopServer, connect, closeSockets, waitFor, arrives, register, rest } = require('./live-server');

let server;
before(async () => { server = await startServer(); });
after(async () => { closeSockets(); await stopServer(server); await db.pool.end(); });
beforeEach(resetDb);
afterEach(closeSockets);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup() {
  const host = await register(server, 'Host');
  const room = (await rest(server, host, 'POST', '/api/rooms', { title: 'WP', goLiveNow: true })).body;
  const join = async (u) => { const s = await connect(server, u?.token); const st = waitFor(s, 'room:state'); s.emit('room:join', { roomId: room.id }); await st; return s; };
  const hs = await join(host);
  const gs = await join(await register(server, 'Guest'));
  await rest(server, host, 'POST', `/api/rooms/${room.id}/watchparty/load`, { youtubeId: 'dQw4w9WgXcQ', title: 'Run' });
  const state = async () => (await rest(server, host, 'GET', `/api/rooms/${room.id}/watchparty`)).body.state;
  return { host, room, hs, gs, state, join };
}

test('loading a video starts the clock at 0, playing', async () => {
  const { state } = await setup();
  const s = await state();
  assert.equal(s.playing, true);
  assert.ok(s.position >= 0 && s.position < 1, `position ${s.position}`);
});

test('the host pauses at their real position: viewers get it, and the room is paused there for anyone who arrives', async () => {
  const { room, hs, gs, state } = await setup();
  const got = waitFor(gs, 'watchparty:control');
  hs.emit('watchparty:control', { roomId: room.id, action: 'pause', position: 42.5 });
  assert.deepEqual(await got, { roomId: room.id, action: 'pause', position: 42.5, playing: false });
  await sleep(600);
  const s = await state();
  assert.equal(s.playing, false);
  assert.equal(s.position, 42.5, 'a paused clock does not move');
});

test('while playing, the clock runs: someone arriving later is told where the video is NOW', async () => {
  const { room, hs, gs, state } = await setup();
  const got = waitFor(gs, 'watchparty:control');
  hs.emit('watchparty:control', { roomId: room.id, action: 'play', position: 10 });
  await got;
  await sleep(1500);
  const s = await state();
  assert.equal(s.playing, true);
  assert.ok(s.position > 11.2 && s.position < 12.2, `expected about 11.5 s, got ${s.position}`);
});

test('seeking keeps play/pause as it was; heartbeats move the clock to the host\'s real position and reach viewers', async () => {
  const { room, hs, gs, state } = await setup();
  hs.emit('watchparty:control', { roomId: room.id, action: 'pause', position: 5 });
  await waitFor(gs, 'watchparty:control');
  const seek = waitFor(gs, 'watchparty:control');
  hs.emit('watchparty:control', { roomId: room.id, action: 'seek', position: 90 });
  assert.deepEqual(await seek, { roomId: room.id, action: 'seek', position: 90, playing: false });
  hs.emit('watchparty:control', { roomId: room.id, action: 'play', position: 90 });
  await waitFor(gs, 'watchparty:control');
  const beat = waitFor(gs, 'watchparty:sync');
  hs.emit('watchparty:sync', { roomId: room.id, position: 93.25 });
  assert.deepEqual(await beat, { roomId: room.id, position: 93.25, playing: true });
  const s = await state();
  assert.ok(s.position >= 93.25 && s.position < 94, `got ${s.position}`);
});

test('"restart" still works: back to 0 and playing', async () => {
  const { room, hs, gs, state } = await setup();
  hs.emit('watchparty:control', { roomId: room.id, action: 'pause', position: 50 });
  await waitFor(gs, 'watchparty:control');
  const got = waitFor(gs, 'watchparty:control');
  hs.emit('watchparty:control', { roomId: room.id, action: 'restart' });
  assert.deepEqual(await got, { roomId: room.id, action: 'restart', position: 0, playing: true });
  assert.ok((await state()).position < 1);
});

test('only the host moves the clock; nonsense positions are ignored', async () => {
  const { room, hs, gs, state } = await setup();
  hs.emit('watchparty:control', { roomId: room.id, action: 'pause', position: 7 });
  await waitFor(gs, 'watchparty:control');
  gs.emit('watchparty:control', { roomId: room.id, action: 'play', position: 300 });
  gs.emit('watchparty:sync', { roomId: room.id, position: 300 });
  assert.equal(await arrives(hs, 'watchparty:control', 400), false);
  assert.equal(await arrives(hs, 'watchparty:sync', 200), false);
  for (const position of [-1, 'x', null, Infinity, 1e9]) hs.emit('watchparty:control', { roomId: room.id, action: 'seek', position });
  hs.emit('watchparty:sync', { roomId: room.id, position: -5 });
  assert.equal(await arrives(gs, 'watchparty:control', 400), false);
  const s = await state();
  assert.equal(s.playing, false);
  assert.equal(s.position, 7);
});

test('a heartbeat while paused does not restart playback', async () => {
  const { room, hs, gs, state } = await setup();
  hs.emit('watchparty:control', { roomId: room.id, action: 'pause', position: 20 });
  await waitFor(gs, 'watchparty:control');
  hs.emit('watchparty:sync', { roomId: room.id, position: 20 });
  await sleep(300);
  assert.equal((await state()).playing, false);
});
