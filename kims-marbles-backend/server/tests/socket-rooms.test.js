// The real-time layer through the REAL server process and real Socket.io clients.
const { test, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./setup');
const { startServer, stopServer, connect, closeSockets, waitFor, arrives, ack, register, rest } = require('./live-server');

let server;
before(async () => { server = await startServer(); });
after(async () => { closeSockets(); await stopServer(server); await db.pool.end(); });
beforeEach(resetDb);
afterEach(closeSockets);

async function liveRoom(handle = 'Host') {
  const host = await register(server, handle);
  const room = (await rest(server, host, 'POST', '/api/rooms', { title: 'Trade Talk', goLiveNow: true })).body;
  return { host, room };
}
async function joined(user, room) {
  const s = await connect(server, user?.token);
  const state = waitFor(s, 'room:state');
  s.emit('room:join', { roomId: room.id });
  await state;
  return s;
}

test('nothing a client sends can crash the server (no payload, wrong types, unknown ids)', async () => {
  const s = await connect(server);
  for (const ev of ['room:join', 'room:chat', 'room:reaction', 'room:command', 'watchparty:load', 'settings:sync', 'device:register', 'ms:join', 'ms:produce', 'ms:consume', 'battle:join']) {
    s.emit(ev);
    s.emit(ev, null);
    s.emit(ev, 42);
    s.emit(ev, ['array']);
    s.emit(ev, { roomId: { $gt: '' }, text: { toString: 1 } });
  }
  await new Promise((r) => setTimeout(r, 500));
  const h = await fetch(`${server.url}/health`);
  assert.equal(h.status, 200, 'the server is still up');
  assert.doesNotMatch(server.output(), /TypeError|Unhandled/);
});

test('room:join: only real, open rooms; the joiner gets the current room state', async () => {
  const { host, room } = await liveRoom();
  const s = await connect(server);
  s.emit('room:join', { roomId: '00000000-0000-0000-0000-000000000000' });
  s.emit('room:join', { roomId: 'not-a-uuid' });
  assert.equal(await arrives(s, 'room:state', 500), false);
  const st = waitFor(s, 'room:state');
  s.emit('room:join', { roomId: room.id });
  const state = await st;
  assert.equal(state.roomId, room.id);
  assert.equal(state.hostId, host.id);
  assert.equal(typeof state.version, 'number');
  await rest(server, host, 'PATCH', `/api/rooms/${room.id}`, { status: 'ended' });
  const late = await connect(server);
  late.emit('room:join', { roomId: room.id });
  assert.equal(await arrives(late, 'room:state', 500), false, 'an ended room cannot be joined');
});

test('chat: members only; the sender gets it back; names come from the login, not the payload; no leaks across rooms', async () => {
  const { host, room } = await liveRoom();
  const guest = await register(server, 'Guest');
  const other = await liveRoom('OtherHost');
  const hs = await joined(host, room);
  const gs = await joined(guest, room);
  const outsider = await joined(other.host, other.room);
  const gotHost = waitFor(hs, 'room:chat');
  const gotSelf = waitFor(gs, 'room:chat');
  gs.emit('room:chat', { roomId: room.id, text: '  hello room  ', handle: 'Admin', userId: host.id });
  const [m1, m2] = await Promise.all([gotHost, gotSelf]);
  assert.equal(m1.text, 'hello room');
  assert.equal(m1.handle, 'Guest', 'handle is taken from the token');
  assert.equal(m1.userId, guest.id);
  assert.deepEqual(m1, m2);
  assert.equal(await arrives(outsider, 'room:chat', 500), false, 'another room hears nothing');
  // not a member of that room: dropped
  outsider.emit('room:chat', { roomId: room.id, text: 'sneaky' });
  assert.equal(await arrives(hs, 'room:chat', 500), false);
  // too long, empty, anonymous: dropped
  gs.emit('room:chat', { roomId: room.id, text: 'x'.repeat(501) });
  gs.emit('room:chat', { roomId: room.id, text: '   ' });
  const anon = await joined(null, room);
  anon.emit('room:chat', { roomId: room.id, text: 'anonymous hello' });
  assert.equal(await arrives(hs, 'room:chat', 600), false);
});

test('chat from one sender arrives in the order it was sent (and is kept as history)', async () => {
  const { host, room } = await liveRoom();
  const g = await register(server, 'Guest');
  const hs = await joined(host, room);
  const gs = await joined(g, room);
  const got = [];
  const done = new Promise((r) => hs.on('room:chat', (m) => { got.push(m.text); if (got.length === 5) r(); }));
  for (let i = 0; i < 5; i++) gs.emit('room:chat', { roomId: room.id, text: `msg ${i}` });
  await done;
  assert.deepEqual(got, ['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4']);
  await new Promise((r) => setTimeout(r, 300));
  const saved = (await db.query('select text from room_chat where room_id = $1 order by id', [room.id])).rows.map((r) => r.text);
  assert.deepEqual(saved.sort(), got.slice().sort());
});

test('moderation: a blocked message reaches NOBODY; the sender is told; the host is flagged on every device; the host is exempt', async () => {
  const { host, room } = await liveRoom();
  const [a, b] = [await register(server, 'GuestA'), await register(server, 'GuestB')];
  await rest(server, host, 'PUT', '/api/moderation', { enabled: true, words: ['scammer', 'spam'] });
  const hs = await joined(host, room);
  const hostPhone = await connect(server, host.token);          // the host's other device, not in the room
  const as = await joined(a, room);
  const bs = await joined(b, room);
  const flagged = waitFor(hostPhone, 'moderation:flagged');
  const blocked = waitFor(as, 'room:chat:blocked');
  as.emit('room:chat', { roomId: room.id, text: 'you absolute SCAMMER' });
  const f = await flagged;
  assert.equal(f.handle, 'GuestA');
  assert.equal(f.word, 'scammer');
  assert.match(f.text, /SCAMMER/);
  assert.ok(await blocked);
  for (const s of [hs, as, bs]) assert.equal(await arrives(s, 'room:chat', 300), false, 'delivered a blocked message');
  const fine = waitFor(bs, 'room:chat');
  as.emit('room:chat', { roomId: room.id, text: 'a spamless lovely day' });
  assert.equal((await fine).text, 'a spamless lovely day');
  const own = waitFor(bs, 'room:chat');
  hs.emit('room:chat', { roomId: room.id, text: 'no spam please' });
  assert.equal((await own).text, 'no spam please', "the host's own list never blocks the host");
});

test("moderation is per host: another host's list does not apply in this room", async () => {
  const { host, room } = await liveRoom();
  const strict = await register(server, 'StrictHost');
  await rest(server, strict, 'PUT', '/api/moderation', { enabled: true, words: ['marbles'] });
  const g = await register(server, 'Guest');
  const hs = await joined(host, room);
  const gs = await joined(g, room);
  const got = waitFor(hs, 'room:chat');
  gs.emit('room:chat', { roomId: room.id, text: 'I love marbles' });
  assert.equal((await got).text, 'I love marbles');
});

test('reactions: members only, a short emoji, everyone in the room sees it', async () => {
  const { host, room } = await liveRoom();
  const hs = await joined(host, room);
  const anon = await joined(null, room);
  const got = waitFor(hs, 'room:reaction');
  anon.emit('room:reaction', { roomId: room.id, emoji: '🔥' });
  assert.equal((await got).emoji, '🔥');
  anon.emit('room:reaction', { roomId: room.id, emoji: 'not an emoji at all' });
  assert.equal(await arrives(hs, 'room:reaction', 500), false);
});

test('host controls: only the host; every device (including the host\'s second one) converges on the same versioned state', async () => {
  const { host, room } = await liveRoom();
  const g = await register(server, 'Guest');
  const desk = await joined(host, room);
  const gs = await joined(g, room);
  assert.deepEqual(await ack(gs, 'room:command', { roomId: room.id, type: 'layout', value: 'spotlight' }), { ok: false, error: 'Only the host can do that' });
  const anon = await joined(null, room);
  assert.equal((await ack(anon, 'room:command', { roomId: room.id, type: 'layout', value: 'spotlight' })).ok, false);
  const seen = waitFor(gs, 'room:state', { pred: (s) => s.layout === 'spotlight' });
  const r = await ack(desk, 'room:command', { roomId: room.id, type: 'layout', value: 'spotlight' });
  assert.equal(r.ok, true);
  const st = await seen;
  const mute = waitFor(gs, 'room:state', { pred: (s) => s.muted[g.id] === true });
  await ack(desk, 'room:command', { roomId: room.id, type: 'mute', targetUserId: g.id, value: true });
  const st2 = await mute;
  assert.ok(st2.version > st.version);
  const phone = await connect(server, host.token);              // the host's phone joins later
  const snap = waitFor(phone, 'room:state');
  phone.emit('room:join', { roomId: room.id });
  const s3 = await snap;
  assert.equal(s3.layout, 'spotlight');
  assert.equal(s3.muted[g.id], true);
  assert.equal((await ack(phone, 'room:command', { roomId: room.id, type: 'camera', targetUserId: g.id, value: true })).ok, true, 'the host on a second device keeps host controls');
  assert.equal((await ack(desk, 'room:command', { roomId: room.id, type: 'teleport', value: 1 })).ok, false);
  assert.equal((await ack(desk, 'room:command', { roomId: room.id, type: 'layout', value: 'chaos' })).ok, false);
});

test('a repeated command id is applied once (a double tap or a retried emit)', async () => {
  const { host, room } = await liveRoom();
  const desk = await joined(host, room);
  const a = await ack(desk, 'room:command', { roomId: room.id, type: 'layout', value: 'spotlight', commandId: 'cmd-1' });
  const b = await ack(desk, 'room:command', { roomId: room.id, type: 'layout', value: 'spotlight', commandId: 'cmd-1' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(b.version, a.version, 'the state version did not move twice');
});

test('watch party over the socket: host only, real YouTube ids only', async () => {
  const { host, room } = await liveRoom();
  const g = await register(server, 'Guest');
  const hs = await joined(host, room);
  const gs = await joined(g, room);
  gs.emit('watchparty:load', { roomId: room.id, youtubeId: 'dQw4w9WgXcQ' });
  assert.equal(await arrives(hs, 'watchparty:load', 500), false, 'a guest cannot load a video');
  hs.emit('watchparty:load', { roomId: room.id, youtubeId: '<script>x</script>' });
  assert.equal(await arrives(gs, 'watchparty:load', 500), false);
  const got = waitFor(gs, 'watchparty:load');
  hs.emit('watchparty:load', { roomId: room.id, youtubeId: 'dQw4w9WgXcQ', title: 'Akro' });
  assert.equal((await got).youtubeId, 'dQw4w9WgXcQ');
  const ctl = waitFor(gs, 'watchparty:control');
  hs.emit('watchparty:control', { roomId: room.id, action: 'pause' });
  assert.equal((await ctl).action, 'pause');
  gs.emit('watchparty:control', { roomId: room.id, action: 'play' });
  assert.equal(await arrives(hs, 'watchparty:control', 500), false);
});

test("settings sync: a theme change reaches the same person's other devices, never the sender or anyone else", async () => {
  const me = await register(server, 'Me');
  const stranger = await register(server, 'Stranger');
  const desk = await connect(server, me.token);
  const phone = await connect(server, me.token);
  const theirs = await connect(server, stranger.token);
  const got = waitFor(phone, 'settings:sync');
  const echoed = arrives(desk, 'settings:sync', 600);          // listen BEFORE sending, or an echo slips past
  const leaked = arrives(theirs, 'settings:sync', 600);
  desk.emit('settings:sync', { key: 'theme', value: 'dark' });
  assert.deepEqual(await got, { key: 'theme', value: 'dark' });
  assert.equal(await echoed, false, 'not echoed to the sender');
  assert.equal(await leaked, false, 'never reaches another person');
  desk.emit('settings:sync', { key: 'isAdmin', value: true });
  desk.emit('settings:sync', { key: 'theme', value: 'neon' });
  assert.equal(await arrives(phone, 'settings:sync', 500), false, 'only whitelisted keys and values');
  const anon = await connect(server);
  anon.emit('settings:sync', { key: 'theme', value: 'dark' });
  assert.equal(await arrives(phone, 'settings:sync', 400), false);
});

test('device list: live as devices register and disconnect', async () => {
  const me = await register(server, 'Me');
  const desk = await connect(server, me.token);
  const one = waitFor(desk, 'device:list', { pred: (l) => l.length === 1 });
  desk.emit('device:register', { deviceId: 'dev-desk', label: '💻 Desktop' });
  await one;
  const phone = await connect(server, me.token);
  const two = waitFor(desk, 'device:list', { pred: (l) => l.length === 2 });
  phone.emit('device:register', { deviceId: 'dev-phone', label: '📱 Mobile' });
  const list = await two;
  assert.deepEqual(list.map((d) => d.label).sort(), ['💻 Desktop', '📱 Mobile']);
  const back = waitFor(desk, 'device:list', { pred: (l) => l.length === 1 });
  phone.disconnect();
  assert.equal((await back)[0].deviceId, 'dev-desk');
});

test('live notifications: a REST action pushes to the recipient\'s open sockets', async () => {
  const [a, b] = [await register(server, 'Alice'), await register(server, 'Bobby')];
  const bs = await connect(server, b.token);
  const got = waitFor(bs, 'notification');
  await rest(server, a, 'POST', `/api/users/${b.id}/follow`);
  assert.equal((await got).type, 'follow');
});

test('ending a room over REST tells everyone in it', async () => {
  const { host, room } = await liveRoom();
  const gs = await joined(await register(server, 'Guest'), room);
  const ended = waitFor(gs, 'room:ended');
  await rest(server, host, 'PATCH', `/api/rooms/${room.id}`, { status: 'ended' });
  assert.equal((await ended).roomId, room.id);
});

test('battle gifts made over REST reach everyone watching the battle', async () => {
  const [a, b, fan] = [await register(server, 'Alice'), await register(server, 'Bobby'), await register(server, 'Fan')];
  const battle = (await rest(server, a, 'POST', '/api/battles', { opponentId: b.id })).body;
  await rest(server, b, 'POST', `/api/battles/${battle.id}/accept`);
  const watcher = await connect(server);
  watcher.emit('battle:join', { battleId: battle.id });
  await new Promise((r) => setTimeout(r, 200));
  const upd = waitFor(watcher, 'battle:update');
  await rest(server, fan, 'POST', `/api/battles/${battle.id}/gift`, { side: 'opponent', giftName: 'Rare Mega', points: 300 });
  assert.equal((await upd).opponent_points, 300);
});

test('"log out everywhere" disconnects that user\'s sockets and nobody else\'s', async () => {
  const [me, other] = [await register(server, 'Me'), await register(server, 'Other')];
  const s1 = await connect(server, me.token);
  const s2 = await connect(server, me.token);
  const o = await connect(server, other.token);
  const gone = Promise.all([s1, s2].map((s) => new Promise((r) => s.once('disconnect', r))));
  await rest(server, me, 'POST', '/api/auth/logout-all');
  await gone;
  assert.equal(o.connected, true);
});

test('flood protection: chat is throttled at the burst limit and the sender is told; a second socket shares the budget', async () => {
  const { host, room } = await liveRoom();
  const g = await register(server, 'Guest');
  const gs = await joined(g, room);
  const gs2 = await joined(g, room);
  const hs = await joined(host, room);
  let delivered = 0;
  hs.on('room:chat', () => { delivered++; });
  const burstIn = waitFor(hs, 'room:chat', { pred: (m) => m.text === 'burst 4' });
  for (let i = 0; i < 5; i++) gs.emit('room:chat', { roomId: room.id, text: `burst ${i}` });
  await burstIn;                                   // two sockets have no ordering guarantee: let the burst land first
  const throttled = waitFor(gs2, 'room:chat:throttled');
  gs2.emit('room:chat', { roomId: room.id, text: 'from my other tab' });
  const t = await throttled;
  assert.ok(t.retryMs > 0 && t.retryMs <= 1000);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(delivered, 5, 'exactly the burst got through');
});

test('flood protection: a connection spamming events is disconnected; others are unaffected', async () => {
  const { host, room } = await liveRoom();
  const spammer = await joined(null, room);
  const hs = await joined(host, room);
  const gone = new Promise((r) => spammer.once('disconnect', () => r(true)));
  for (let i = 0; i < 400; i++) spammer.emit('room:reaction', { roomId: room.id, emoji: '🔥' });
  assert.equal(await Promise.race([gone, new Promise((r) => setTimeout(() => r(false), 5000))]), true, 'the flooding connection was not disconnected');
  assert.equal(hs.connected, true);
  const got = waitFor(hs, 'room:chat');
  hs.emit('room:chat', { roomId: room.id, text: 'still here' });
  assert.equal((await got).text, 'still here');
});

test('graceful shutdown: SIGTERM with clients connected exits 0 within seconds', async () => {
  const s2 = await startServer();
  const u = await register(s2, 'Bye');
  await connect(s2, u.token);
  await connect(s2);
  const t0 = Date.now();
  const code = new Promise((r) => s2.once('exit', r));
  s2.kill('SIGTERM');
  assert.equal(await code, 0);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test('a suspended account is cut off from real-time at once and cannot reconnect', async () => {
  const admin = await register(server, 'Admin');
  await db.query('update users set is_admin = true where id = $1', [admin.id]);
  const bob = await register(server, 'Bob');
  const s = await connect(server, bob.token);
  const gone = new Promise((r) => s.once('disconnect', r));
  assert.equal((await rest(server, admin, 'POST', `/api/users/${bob.id}/ban`, { reason: 'x' })).status, 200);
  await gone;
  await assert.rejects(connect(server, bob.token), /unauthorized/);
});
