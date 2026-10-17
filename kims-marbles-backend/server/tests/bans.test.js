// Suspending an account: admins only, takes effect everywhere at once (API, refresh, login,
// sockets), takes the person's listings and live rooms down, and can be undone.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db, boot, api, user, as } = require('./helpers');

before(boot);
beforeEach(resetDb);
after(() => db.pool.end());

async function login(u, password = 'password123') {
  return api().post('/api/auth/login').send({ email: `${u.handle.toLowerCase()}@x.com`, password });
}
const listing = async (u, name = 'Swirl') => (await api().post('/api/listings').set(as(u)).send({ name, category: 'Swirl', grade: 'mint', type: 'sale', priceCents: 1000 })).body;

test('only admins can suspend, never themselves or another admin', async () => {
  const admin = await user('Admin', { admin: true }); const other = await user('OtherAdmin', { admin: true });
  const bob = await user('Bob'); const eve = await user('Eve');
  assert.equal((await api().post(`/api/users/${bob.id}/ban`).set(as(eve)).send({ reason: 'x' })).status, 403);
  assert.equal((await api().post(`/api/users/${admin.id}/ban`).set(as(admin)).send({})).status, 400);
  assert.equal((await api().post(`/api/users/${other.id}/ban`).set(as(admin)).send({})).status, 400);
  assert.equal((await api().post('/api/users/00000000-0000-0000-0000-000000000000/ban').set(as(admin)).send({})).status, 404);
  assert.equal((await api().post(`/api/users/${bob.id}/ban`).set(as(admin)).send({ reason: 'x'.repeat(281) })).status, 400);
});

test('a suspension takes effect at once: tokens, refresh and login all stop, with a clear message', async () => {
  const admin = await user('Admin', { admin: true }); const bob = await user('Bob');
  const session = (await login(bob)).body;
  const r = await api().post(`/api/users/${bob.id}/ban`).set(as(admin)).send({ reason: 'Scamming buyers' });
  assert.equal(r.status, 200);
  assert.ok(r.body.banned_at);
  const me = await api().get('/api/auth/me').set(as(bob));
  assert.equal(me.status, 401);
  assert.match(me.body.error, /suspended/);
  assert.equal((await api().post('/api/auth/refresh').send({ refreshToken: session.refreshToken })).status, 401);
  const again = await login(bob);
  assert.equal(again.status, 403);
  assert.match(again.body.error, /suspended/);
  // a wrong password on a suspended account says "wrong password", not "suspended" (no account probing)
  assert.equal((await login(bob, 'not-the-password')).status, 401);
  // public pages no longer personalise for the banned token
  assert.equal((await api().get('/api/listings').set(as(bob))).status, 200);
});

test('their active listings and live rooms come down; other people\'s stay', async () => {
  const admin = await user('Admin', { admin: true }); const bob = await user('Bob'); const ann = await user('Ann');
  const lb = await listing(bob, 'Bob swirl'); const la = await listing(ann, 'Ann swirl');
  const room = (await api().post('/api/rooms').set(as(bob)).send({ title: 'Bob live', goLiveNow: true })).body;
  await api().post(`/api/users/${bob.id}/ban`).set(as(admin)).send({});
  const names = (await api().get('/api/listings')).body.map((l) => l.name);
  assert.deepEqual(names, ['Ann swirl']);
  assert.equal((await db.query('select status from listings where id = $1', [lb.id])).rows[0].status, 'removed');
  assert.equal((await db.query('select status from listings where id = $1', [la.id])).rows[0].status, 'active');
  assert.equal((await db.query('select status from rooms where id = $1', [room.id])).rows[0].status, 'ended');
});

test('unsuspending lets them log in again (removed listings stay removed); admins see who is suspended', async () => {
  const admin = await user('Admin', { admin: true }); const bob = await user('Bob');
  await listing(bob);
  await api().post(`/api/users/${bob.id}/ban`).set(as(admin)).send({ reason: 'spam' });
  const list = await api().get('/api/users/banned').set(as(admin));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((u) => [u.handle, u.banned_reason, u.banned_by_handle]), [['Bob', 'spam', 'Admin']]);
  assert.equal((await api().get('/api/users/banned').set(as(bob))).status, 401);
  assert.equal((await api().post(`/api/users/${bob.id}/unban`).set(as(admin))).status, 200);
  assert.equal((await login(bob)).status, 200);
  assert.equal((await api().get('/api/listings')).body.length, 0);
  assert.deepEqual((await api().get('/api/users/banned').set(as(admin))).body, []);
});

test('from a report: "ban the author" finds the owner of the reported thing, bans them and closes the report', async () => {
  const admin = await user('Admin', { admin: true }); const bob = await user('Bob'); const ann = await user('Ann');
  const post = (await api().post('/api/feed').set(as(bob)).send({ text: 'buy followers' })).body;
  const rep = (await api().post('/api/reports').set(as(ann)).send({ targetType: 'post', targetId: post.id, reason: 'Spam' })).body;
  const r = await api().post(`/api/reports/${rep.id}/ban-author`).set(as(admin)).send({ reason: 'spam' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.handle, 'Bob');
  assert.equal((await db.query('select status from reports where id = $1', [rep.id])).rows[0].status, 'actioned');
  assert.ok((await db.query('select banned_at from users where id = $1', [bob.id])).rows[0].banned_at);
  assert.equal((await api().post(`/api/reports/${rep.id}/ban-author`).set(as(ann)).send({})).status, 403);
});

test('ban-author works for every kind of report, and refuses when the owner is an admin or gone', async () => {
  const admin = await user('Admin', { admin: true }); const ann = await user('Ann');
  const mk = async (type, id) => (await api().post('/api/reports').set(as(ann)).send({ targetType: type, targetId: id, reason: 'x' })).body.id;
  const seller = await user('Seller'); const l = await listing(seller);
  const host = await user('Host'); const room = (await api().post('/api/rooms').set(as(host)).send({ title: 'r', goLiveNow: true })).body;
  const troll = await user('Troll');
  for (const [rid, who] of [[await mk('listing', l.id), 'Seller'], [await mk('panel', room.id), 'Host'], [await mk('user', troll.id), 'Troll']]) {
    const r = await api().post(`/api/reports/${rid}/ban-author`).set(as(admin)).send({});
    assert.equal(r.status, 200, who);
    assert.equal(r.body.user.handle, who);
  }
  assert.equal((await api().post(`/api/reports/${await mk('user', admin.id)}/ban-author`).set(as(admin)).send({})).status, 400);
  assert.equal((await api().post(`/api/reports/${await mk('post', '00000000-0000-0000-0000-000000000000')}/ban-author`).set(as(admin)).send({})).status, 404);
});
