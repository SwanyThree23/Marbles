// Feed, collection, direct messages, profiles/follows, notifications, offers inbox, reports.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db, boot, api, user, as, NIL, notes } = require('./helpers');

before(boot);
beforeEach(resetDb);
after(() => db.pool.end());

const item = (u, over = {}) => api().post('/api/collection').set(as(u)).send({ name: 'Blue Swirl', icon: '🔮', estValueCents: 1500, ...over });

// ---------------- feed ----------------
test('feed: newest first, with author, like/comment counts and "liked by me" per viewer', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  const p1 = (await api().post('/api/feed').set(as(a)).send({ text: 'first haul' })).body;
  await api().post('/api/feed').set(as(b)).send({ text: 'second' });
  await api().post(`/api/feed/${p1.id}/like`).set(as(b));
  await api().post(`/api/feed/${p1.id}/comments`).set(as(b)).send({ text: 'nice!' });
  const asB = (await api().get('/api/feed').set(as(b))).body;
  assert.deepEqual(asB.map((p) => p.text), ['second', 'first haul']);
  const post = asB[1];
  assert.equal(post.author_handle, 'Alice');
  assert.equal(post.like_count, 1);
  assert.equal(post.comment_count, 1);
  assert.equal(post.liked_by_me, true);
  assert.equal((await api().get('/api/feed').set(as(a))).body[1].liked_by_me, false);
  assert.equal((await api().get('/api/feed')).body[1].liked_by_me, false, 'anonymous viewers can read the feed');
});

test('feed: likes toggle; comments are validated and listed; unknown or malformed posts are 404', async () => {
  const a = await user('Alice');
  const p = (await api().post('/api/feed').set(as(a)).send({ text: 'hi' })).body;
  assert.deepEqual((await api().post(`/api/feed/${p.id}/like`).set(as(a))).body, { liked: true, likeCount: 1 });
  assert.deepEqual((await api().post(`/api/feed/${p.id}/like`).set(as(a))).body, { liked: false, likeCount: 0 });
  assert.equal((await api().post(`/api/feed/${p.id}/comments`).set(as(a)).send({ text: '' })).status, 400);
  assert.equal((await api().post(`/api/feed/${p.id}/comments`).set(as(a)).send({ text: 'x'.repeat(1001) })).status, 400);
  await api().post(`/api/feed/${p.id}/comments`).set(as(a)).send({ text: 'one' });
  const list = (await api().get(`/api/feed/${p.id}/comments`)).body;
  assert.deepEqual(list.map((c) => [c.text, c.author_handle]), [['one', 'Alice']]);
  for (const id of [NIL, 'not-a-uuid']) {
    assert.equal((await api().post(`/api/feed/${id}/like`).set(as(a))).status, 404);
    assert.equal((await api().get(`/api/feed/${id}/comments`)).status, 404);
  }
});

test('feed: you can attach only your own marble, and delete only your own post', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  const mine = (await item(a)).body;
  const theirs = (await item(b)).body;
  assert.equal((await api().post('/api/feed').set(as(a)).send({ text: 'look', attachCollectionItemId: theirs.id })).status, 400);
  const p = (await api().post('/api/feed').set(as(a)).send({ text: 'look', attachCollectionItemId: mine.id })).body;
  const feed = (await api().get('/api/feed')).body;
  assert.equal(feed[0].attach_name, 'Blue Swirl');
  assert.equal(feed[0].attach_icon, '🔮');
  assert.equal((await api().delete(`/api/feed/${p.id}`).set(as(b))).status, 403);
  assert.equal((await api().delete(`/api/feed/${p.id}`).set(as(a))).status, 204);
  assert.equal((await api().get('/api/feed')).body.length, 0);
});

// ---------------- collection ----------------
test('collection: mine only; the third marble earns Collector; leaderboard is public and summed', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  await item(a, { estValueCents: 1000 });
  await item(a, { name: 'Two', estValueCents: 2000 });
  const third = (await item(a, { name: 'Three', estValueCents: 500 })).body;
  await item(b, { estValueCents: 99999 });
  const mine = (await api().get('/api/collection').set(as(a))).body;
  assert.equal(mine.length, 3);
  const ach = (await api().get('/api/achievements').set(as(a))).body.find((x) => x.key === 'collector');
  assert.equal(ach.unlocked, true);
  assert.equal((await api().delete(`/api/collection/${third.id}`).set(as(b))).status, 404, "you cannot delete someone else's marble");
  assert.equal((await api().delete(`/api/collection/${third.id}`).set(as(a))).status, 204);
  const lb = (await api().get('/api/collection/leaderboard')).body;
  assert.deepEqual(lb.map((r) => [r.handle, r.item_count, r.total_value_cents]), [['Bobby', 1, 99999], ['Alice', 2, 3000]]);
  assert.equal((await api().get('/api/collection')).status, 401);
});

// ---------------- messages ----------------
test('messages: one conversation per pair, an inbox with unread markers, reading clears them', async () => {
  const [a, b, c] = [await user('Alice'), await user('Bobby'), await user('Carol')];
  const send = (from, to, text) => api().post(`/api/conversations/with/${to.id}`).set(as(from)).send({ text });
  assert.equal((await send(a, b, 'hi Bobby')).status, 201);
  await send(b, a, 'hey Alice');
  await send(a, b, 'got any oxbloods?');
  assert.equal((await db.query('select count(*)::int as n from conversations')).rows[0].n, 1);
  const inboxB = (await api().get('/api/conversations').set(as(b))).body;
  assert.equal(inboxB.length, 1);
  assert.equal(inboxB[0].other_handle, 'Alice');
  assert.equal(inboxB[0].last_text, 'got any oxbloods?');
  assert.equal(inboxB[0].unread, true);
  const thread = (await api().get(`/api/conversations/with/${a.id}`).set(as(b))).body;
  assert.deepEqual(thread.messages.map((m) => m.text), ['hi Bobby', 'hey Alice', 'got any oxbloods?']);
  assert.equal((await api().get('/api/conversations').set(as(b))).body[0].unread, false);
  assert.equal((await api().get('/api/conversations').set(as(c))).body.length, 0, 'a third person sees nothing');
  assert.equal((await notes(b)).filter((n) => n.type === 'message').length, 2);
});

test('messages: validated; not to yourself; unknown or malformed users are 404', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  assert.equal((await api().post(`/api/conversations/with/${a.id}`).set(as(a)).send({ text: 'me' })).status, 400);
  assert.equal((await api().post(`/api/conversations/with/${b.id}`).set(as(a)).send({ text: '' })).status, 400);
  assert.equal((await api().post(`/api/conversations/with/${b.id}`).set(as(a)).send({ text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await api().post(`/api/conversations/with/${NIL}`).set(as(a)).send({ text: 'hi' })).status, 404);
  assert.equal((await api().get('/api/conversations/with/not-a-uuid').set(as(a))).status, 404);
});

// ---------------- profiles and follows ----------------
test('profiles are public (no email), case-insensitive, with stats; you can edit only your own bio and icon', async () => {
  const a = await user('Alice');
  await api().post('/api/listings').set(as(a)).send({ name: 'x', category: 'Swirl', grade: 'mint', type: 'sale', priceCents: 100 });
  const p = await api().get('/api/users/alice');
  assert.equal(p.status, 200);
  assert.equal(p.body.handle, 'Alice');
  assert.equal(p.body.listings, 1);
  assert.equal(p.body.email, undefined);
  assert.equal(p.body.password_hash, undefined);
  assert.equal((await api().get('/api/users/nobody_here')).status, 404);
  const upd = await api().patch('/api/users/me').set(as(a)).send({ bio: 'Swirls since 2019', avatarIcon: '🦋', is_admin: true, handle: 'Hacker' });
  assert.equal(upd.status, 200);
  const row = (await db.query('select handle, bio, avatar_icon, is_admin from users where id = $1', [a.id])).rows[0];
  assert.deepEqual(row, { handle: 'Alice', bio: 'Swirls since 2019', avatar_icon: '🦋', is_admin: false }, 'admin and handle cannot be set through the API');
  assert.equal((await api().patch('/api/users/me').set(as(a)).send({ bio: 'x'.repeat(281) })).status, 400);
  assert.equal((await api().patch('/api/users/me').set(as(a)).send({ avatarIcon: 'x'.repeat(9) })).status, 400);
});

test('follow toggles, notifies, earns Socialite; not yourself; unknown is 404', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  assert.deepEqual((await api().post(`/api/users/${b.id}/follow`).set(as(a))).body, { following: true });
  assert.equal((await api().get('/api/users/Bobby')).body.followers, 1);
  assert.deepEqual((await api().post(`/api/users/${b.id}/follow`).set(as(a))).body, { following: false });
  assert.equal((await api().post(`/api/users/${a.id}/follow`).set(as(a))).status, 400);
  assert.equal((await api().post(`/api/users/${NIL}/follow`).set(as(a))).status, 404);
  assert.equal((await notes(b))[0].type, 'follow');
  assert.ok((await api().get('/api/achievements').set(as(a))).body.find((x) => x.key === 'followed').unlocked);
});

// ---------------- notifications ----------------
test('notifications: mine only, newest first; marking someone else\'s as read is 404', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  await api().post(`/api/users/${b.id}/follow`).set(as(a));
  await api().post(`/api/users/${a.id}/follow`).set(as(b));
  const nb = (await api().get('/api/notifications').set(as(b))).body;
  assert.equal(nb.length, 1);
  assert.equal(nb[0].read, false);
  const na = (await api().get('/api/notifications').set(as(a))).body;
  assert.equal((await api().patch(`/api/notifications/${na[0].id}/read`).set(as(b))).status, 404);
  assert.equal((await api().patch(`/api/notifications/${nb[0].id}/read`).set(as(b))).status, 204);
  assert.equal((await api().get('/api/notifications').set(as(b))).body[0].read, true);
  assert.equal((await api().patch('/api/notifications/not-a-uuid/read').set(as(b))).status, 404);
});

// ---------------- offers inbox ----------------
test('offers: the seller sees and answers offers; the buyer hears back; nobody else can answer', async () => {
  const [s, b, o] = [await user('Seller'), await user('Buyer'), await user('Other')];
  const l = (await api().post('/api/listings').set(as(s)).send({ name: 'Lutz', category: 'Vintage', grade: 'mint', type: 'sale', priceCents: 9000 })).body;
  const offer = (await api().post(`/api/listings/${l.id}/offers`).set(as(b)).send({ kind: 'offer', offerAmountCents: 8000 })).body;
  const inbox = (await api().get('/api/offers?role=seller').set(as(s))).body;
  assert.deepEqual(inbox.map((x) => [x.id, x.buyer_handle, x.listing_name]), [[offer.id, 'Buyer', 'Lutz']]);
  assert.deepEqual((await api().get('/api/offers?role=buyer').set(as(b))).body.map((x) => x.id), [offer.id]);
  const answer = (u, status) => api().patch(`/api/offers/${offer.id}`).set(as(u)).send({ status });
  assert.equal((await answer(b, 'accepted')).status, 403, 'the buyer cannot accept their own offer');
  assert.equal((await answer(o, 'accepted')).status, 403);
  assert.equal((await answer(s, 'paid')).status, 400, 'paid is set by the payment, not by a person');
  assert.equal((await answer(s, 'accepted')).body.status, 'accepted');
  assert.equal((await answer(s, 'declined')).status, 409, 'only pending offers can be answered');
  assert.equal((await notes(b)).at(-1).type, 'offer_accepted');
  assert.equal((await api().patch(`/api/offers/${NIL}`).set(as(s)).send({ status: 'accepted' })).status, 404);
});

// ---------------- reports (moderation queue) ----------------
test('reports: anyone logged in can file one (validated); only admins see the queue and resolve it', async () => {
  const [a, mod] = [await user('Alice'), await user('Mod', { admin: true })];
  const file = (body) => api().post('/api/reports').set(as(a)).send({ targetType: 'listing', targetId: NIL, reason: 'Spam', ...body });
  for (const bad of [{ targetType: 'planet' }, { targetId: 'nope' }, { reason: '' }, { details: 'x'.repeat(1001) }]) {
    assert.equal((await file(bad)).status, 400, JSON.stringify(bad));
  }
  const r = await file({ targetLabel: 'Fake Lutz', details: 'stock photo' });
  assert.equal(r.status, 201);
  assert.equal((await api().get('/api/reports').set(as(a))).status, 403);
  const queue = (await api().get('/api/reports').set(as(mod))).body;
  assert.deepEqual(queue.map((x) => [x.reason, x.reporter_handle, x.status]), [['Spam', 'Alice', 'open']]);
  assert.equal((await api().patch(`/api/reports/${r.body.id}`).set(as(a)).send({ status: 'dismissed' })).status, 403);
  assert.equal((await api().patch(`/api/reports/${r.body.id}`).set(as(mod)).send({ status: 'open' })).status, 400);
  const done = await api().patch(`/api/reports/${r.body.id}`).set(as(mod)).send({ status: 'actioned' });
  assert.equal(done.body.status, 'actioned');
  assert.equal(done.body.resolved_by, mod.id);
  assert.equal((await api().get('/api/reports?status=open').set(as(mod))).body.length, 0);
});
