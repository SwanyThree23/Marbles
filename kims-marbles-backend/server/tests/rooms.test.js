// Live rooms (panels/broadcasts), one-time invites, and the watch-party REST side.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db, boot, api, user, as, NIL } = require('./helpers');

before(boot);
beforeEach(resetDb);
after(() => db.pool.end());

const room = (u, body) => api().post('/api/rooms').set(as(u)).send({ title: 'Sunday Trade Talk', ...body });

test('create: scheduled by default, live with goLiveNow; validated', async () => {
  const h = await user('Host');
  const s = await room(h, { scheduledFor: new Date(Date.now() + 3600_000).toISOString(), category: 'Appraisal' });
  assert.equal(s.status, 201);
  assert.equal(s.body.status, 'scheduled');
  assert.equal(s.body.started_at, null);
  const l = await room(h, { goLiveNow: true });
  assert.equal(l.body.status, 'live');
  assert.ok(l.body.started_at);
  for (const bad of [{ title: '' }, { title: 'x'.repeat(121) }, { category: 'x'.repeat(41) }, { maxGuests: 0 }, { maxGuests: 51 },
    { scheduledFor: 'tomorrow-ish' }, { goLiveNow: 'yes' }]) {
    assert.equal((await room(h, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api().post('/api/rooms').send({ title: 'x' })).status, 401);
});

test('list and get: public, with host handle and live guest count; 404 for unknown or malformed ids', async () => {
  const [h, g] = [await user('Host'), await user('Guest')];
  const live = (await room(h, { goLiveNow: true, title: 'Live One' })).body;
  await room(h, { title: 'Later One' });
  await api().post(`/api/rooms/${live.id}/join`).set(as(g));
  const all = (await api().get('/api/rooms')).body;
  assert.equal(all.length, 2);
  const onlyLive = (await api().get('/api/rooms?status=live')).body;
  assert.deepEqual(onlyLive.map((r) => r.title), ['Live One']);
  assert.equal(onlyLive[0].host_handle, 'Host');
  assert.equal(onlyLive[0].guest_count, 1);
  const one = await api().get(`/api/rooms/${live.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.host_handle, 'Host');
  assert.equal(one.body.host_id, h.id);
  assert.equal((await api().get(`/api/rooms/${NIL}`)).status, 404);
  assert.equal((await api().get('/api/rooms/not-a-uuid')).status, 404);
});

test('only the host changes a room; ended is final; going live stamps started_at', async () => {
  const [h, o] = [await user('Host'), await user('Other')];
  const r = (await room(h)).body;
  const patch = (u, status) => api().patch(`/api/rooms/${r.id}`).set(as(u)).send({ status });
  assert.equal((await patch(o, 'live')).status, 403);
  assert.equal((await patch(h, 'paused')).status, 400);
  const live = await patch(h, 'live');
  assert.equal(live.body.status, 'live');
  assert.ok(live.body.started_at);
  const ended = await patch(h, 'ended');
  assert.ok(ended.body.ended_at);
  assert.equal((await patch(h, 'live')).status, 409, 'an ended room cannot reopen');
  assert.equal((await api().patch(`/api/rooms/${NIL}`).set(as(h)).send({ status: 'live' })).status, 404);
});

test('join: live rooms only, capacity enforced, rejoining is fine, leave frees the seat', async () => {
  const h = await user('Host');
  const gs = await Promise.all(['G1', 'G2', 'G3'].map((n) => user(n)));
  const scheduled = (await room(h)).body;
  assert.equal((await api().post(`/api/rooms/${scheduled.id}/join`).set(as(gs[0]))).status, 409);
  const r = (await room(h, { goLiveNow: true, maxGuests: 2 })).body;
  const join = (u) => api().post(`/api/rooms/${r.id}/join`).set(as(u));
  assert.equal((await join(gs[0])).status, 200);
  assert.equal((await join(gs[0])).status, 200, 'rejoining does not take a second seat');
  assert.equal((await join(gs[1])).status, 200);
  assert.equal((await join(gs[2])).status, 409, 'the room is full');
  assert.equal((await join(h)).status, 200, 'the host never needs a seat');
  assert.equal((await api().post(`/api/rooms/${r.id}/leave`).set(as(gs[0]))).status, 200);
  assert.equal((await join(gs[2])).status, 200);
  assert.equal((await api().post(`/api/rooms/${NIL}/join`).set(as(gs[0]))).status, 404);
});

test('invites: host only; one person may redeem (and retry); everyone else is refused; expired is refused', async () => {
  const [h, a, b, o] = [await user('Host'), await user('Ann'), await user('Ben'), await user('Other')];
  const r = (await room(h, { goLiveNow: true, maxGuests: 1 })).body;
  assert.equal((await api().post(`/api/rooms/${r.id}/invite`).set(as(o))).status, 403);
  const inv = await api().post(`/api/rooms/${r.id}/invite`).set(as(h));
  assert.equal(inv.status, 201);
  assert.match(inv.body.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(inv.body.expiresInMinutes, 120);
  assert.ok(inv.body.url.endsWith(`/join/${inv.body.token}`));
  const stored = (await db.query('select token_hash from room_invites')).rows[0].token_hash;
  assert.notEqual(stored, inv.body.token, 'only a hash of the invite is stored');

  await api().post(`/api/rooms/${r.id}/join`).set(as(o));       // fills the one seat
  const redeem = (u, t = inv.body.token) => api().post(`/api/rooms/invite/${t}`).set(as(u));
  const first = await redeem(a);
  assert.equal(first.status, 200, 'an invited guest gets in even when the room is full');
  assert.equal(first.body.room.id, r.id);
  assert.equal((await redeem(a)).status, 200, 'the same person may redeem again (a refresh)');
  assert.equal((await redeem(b)).status, 410, 'a second person is refused');
  assert.equal((await redeem(b, 'no-such-invite-token-value')).status, 404);
  assert.equal((await api().post(`/api/rooms/invite/${inv.body.token}`)).status, 401);

  const inv2 = (await api().post(`/api/rooms/${r.id}/invite`).set(as(h))).body;
  await db.query("update room_invites set expires_at = now() - interval '1 second' where claimed_by is null");
  assert.equal((await redeem(b, inv2.token)).status, 410, 'expired');
});

test('watch party: anyone can read; only the host loads a video; ids are real YouTube ids; queue is capped', async () => {
  const [h, g] = [await user('Host'), await user('Guest')];
  const r = (await room(h, { goLiveNow: true })).body;
  const load = (u, youtubeId) => api().post(`/api/rooms/${r.id}/watchparty/load`).set(as(u)).send({ youtubeId, title: 'Akro factory' });
  assert.equal((await load(g, 'dQw4w9WgXcQ')).status, 403);
  for (const bad of ['short', 'has space__', '<script>xx>', 42]) assert.equal((await load(h, bad)).status, 400, String(bad));
  assert.equal((await load(h, 'dQw4w9WgXcQ')).status, 200);
  const queue = (u, youtubeId) => api().post(`/api/rooms/${r.id}/watchparty/queue`).set(as(u)).send({ youtubeId, title: 'Next' });
  assert.equal((await queue(g, 'jNQXAC9IVRw')).status, 201, 'guests may suggest videos');
  const wp = (await api().get(`/api/rooms/${r.id}/watchparty`)).body;
  assert.equal(wp.state.youtube_id, 'dQw4w9WgXcQ');
  assert.deepEqual(wp.queue.map((q) => q.youtube_id), ['jNQXAC9IVRw']);
  await db.query(`insert into watchparty_queue (room_id, youtube_id) select $1, 'jNQXAC9IVRw' from generate_series(1, 49)`, [r.id]);
  assert.equal((await queue(g, 'jNQXAC9IVRw')).status, 409, 'queue is capped at 50');
  assert.equal((await api().get(`/api/rooms/${NIL}/watchparty`)).status, 404);
});
