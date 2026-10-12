// Dashboard: server-side activity history, achievements that can only be EARNED (never
// self-awarded), game bests, saved listing templates, and the aggregate the dashboard shows.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./setup');

let request; let app; let activity;
before(async () => { request = (await import('supertest')).default; app = require('../app'); activity = require('../activity'); });
beforeEach(resetDb);
after(() => db.pool.end());

async function user(handle) {
  const r = await request(app).post('/api/auth/register').send({ handle, email: `${handle.toLowerCase()}@x.com`, password: 'password123' });
  return { token: r.body.accessToken, id: r.body.user.id, handle };
}
const as = (u) => ({ Authorization: `Bearer ${u.token}` });
const unlocked = async (u) => (await request(app).get('/api/achievements').set(as(u))).body.filter((a) => a.unlocked).map((a) => a.key).sort();
const listing = (u, over = {}) => request(app).post('/api/listings').set(as(u)).send({ name: 'Oxblood', category: 'Swirl', grade: 'mint', type: 'sale', priceCents: 8500, ...over });
const activityOf = async (u, q = '') => (await request(app).get(`/api/activity${q}`).set(as(u))).body;

// ---------------- achievements can only be earned ----------------
test('the client can no longer award itself achievements', async () => {
  const u = await user('Cheater');
  for (const key of ['listed', 'quizWhiz', 'wentLive', 'not-a-real-badge']) {
    const res = await request(app).post(`/api/achievements/${key}/unlock`).set(as(u));
    assert.equal(res.status, 403, `${key} should be refused`);
  }
  assert.deepEqual(await unlocked(u), []);
});

test('creating a listing earns "listed"; sending an offer earns "traded"', async () => {
  const [seller, buyer] = [await user('Seller'), await user('Buyer')];
  const l = (await listing(seller)).body;
  assert.deepEqual(await unlocked(seller), ['listed']);
  await request(app).post(`/api/listings/${l.id}/offers`).set(as(buyer)).send({ kind: 'offer', offerAmountCents: 7000 });
  assert.deepEqual(await unlocked(buyer), ['traded']);
});

test('sending a battle challenge earns "rival"-style "challenged"', async () => {
  const [a, b] = [await user('Chal'), await user('Opp')];
  await request(app).post('/api/battles').set(as(a)).send({ opponentId: b.id });
  assert.deepEqual(await unlocked(a), ['challenged']);
  assert.deepEqual(await unlocked(b), [], 'the opponent did not earn anything by being challenged');
});

test('going live earns "wentLive" — creating a SCHEDULED room does not, starting it later does', async () => {
  const u = await user('Caster');
  const scheduled = (await request(app).post('/api/rooms').set(as(u)).send({ title: 'Later' })).body;
  assert.deepEqual(await unlocked(u), []);
  await request(app).patch(`/api/rooms/${scheduled.id}`).set(as(u)).send({ status: 'live' });
  assert.deepEqual(await unlocked(u), ['wentLive']);
  const v = await user('Caster2');
  await request(app).post('/api/rooms').set(as(v)).send({ title: 'Now', goLiveNow: true });
  assert.deepEqual(await unlocked(v), ['wentLive']);
});

test('a 70%+ trivia score earns "quizWhiz"; a lower one does not; repeating never duplicates', async () => {
  const u = await user('Quizzer');
  await request(app).post('/api/games/trivia/score').set(as(u)).send({ score: 4, outOf: 7 });
  assert.deepEqual(await unlocked(u), []);
  await request(app).post('/api/games/trivia/score').set(as(u)).send({ score: 5, outOf: 7 });
  await request(app).post('/api/games/trivia/score').set(as(u)).send({ score: 7, outOf: 7 });
  assert.deepEqual(await unlocked(u), ['quizWhiz']);
  assert.equal((await db.query("select count(*)::int as n from user_achievements where achievement_key = 'quizWhiz'")).rows[0].n, 1);
});

// ---------------- activity history ----------------
test('activity records what you do, newest first, with readable text', async () => {
  const u = await user('Busy');
  await listing(u, { name: 'Blue Swirl' });
  await request(app).post('/api/feed').set(as(u)).send({ text: 'hello world' });
  await request(app).post('/api/rooms').set(as(u)).send({ title: 'My Stream', goLiveNow: true });
  const rows = await activityOf(u);
  assert.deepEqual(rows.map((r) => r.kind), ['live', 'post', 'listed']);
  assert.match(rows[2].text, /Blue Swirl/);
  assert.match(rows[0].text, /My Stream/);
  assert.ok(rows.every((r) => r.created_at));
});

test('activity is private: you only ever see your own', async () => {
  const [a, b] = [await user('Priv1'), await user('Priv2')];
  await listing(a, { name: 'Secret One' });
  await listing(b, { name: 'Other One' });
  const mine = await activityOf(a);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /Secret One/);
});

test('activity requires a login and validates ?limit (clamped to 50, junk -> 400)', async () => {
  const u = await user('Lim');
  assert.equal((await request(app).get('/api/activity')).status, 401);
  for (let i = 0; i < 60; i++) await activity.recordActivity(u.id, 'post', `event ${i}`);
  assert.equal((await activityOf(u, '?limit=1000')).length, 50);
  assert.equal((await activityOf(u, '?limit=5')).length, 5);
  assert.equal((await activityOf(u)).length, 30);
  assert.equal((await request(app).get('/api/activity?limit=abc').set(as(u))).status, 400);
  assert.equal((await request(app).get('/api/activity?limit=0').set(as(u))).status, 400);
});

test('only the latest 200 events per user are kept', async () => {
  const u = await user('Hoarder');
  for (let i = 0; i < 210; i++) await activity.recordActivity(u.id, 'post', `event ${i}`);
  assert.equal((await db.query('select count(*)::int as n from activity_events where user_id = $1', [u.id])).rows[0].n, 200);
  assert.match((await activityOf(u))[0].text, /event 209/);
});

// ---------------- game scores ----------------
test('game scores validate their input', async () => {
  const u = await user('Gamer');
  const post = (game, body) => request(app).post(`/api/games/${game}/score`).set(as(u)).send(body);
  assert.equal((await post('chess', { score: 1 })).status, 404);
  for (const bad of [{ score: 1.5 }, { score: -1 }, { score: '5' }, { score: null }, {}, { score: 1001 }]) {
    assert.equal((await post('speed', bad)).status, 400, `speed ${JSON.stringify(bad)}`);
  }
  for (const bad of [{ score: 3 }, { score: 8, outOf: 7 }, { score: 3, outOf: 0 }, { score: 3, outOf: 51 }, { score: -1, outOf: 7 }]) {
    assert.equal((await post('trivia', bad)).status, 400, `trivia ${JSON.stringify(bad)}`);
  }
  assert.equal((await request(app).post('/api/games/speed/score').send({ score: 3 })).status, 401);
});

test('the best score is kept (never lowered), plays are counted, and a new best is reported', async () => {
  const u = await user('Streak');
  const post = async (score) => (await request(app).post('/api/games/speed/score').set(as(u)).send({ score })).body;
  assert.deepEqual(await post(7), { best: 7, plays: 1, newBest: true });
  assert.deepEqual(await post(3), { best: 7, plays: 2, newBest: false });
  assert.deepEqual(await post(12), { best: 12, plays: 3, newBest: true });
});

test('game scores are per user and per game', async () => {
  const [a, b] = [await user('GA'), await user('GB')];
  await request(app).post('/api/games/speed/score').set(as(a)).send({ score: 9 });
  const dash = (await request(app).get('/api/dashboard').set(as(b))).body;
  assert.deepEqual(dash.games.speed, { best: 0, plays: 0 });
  assert.deepEqual(dash.games.trivia, { best: 0, plays: 0 });
});

// ---------------- saved listing templates ----------------
const tpl = (over = {}) => ({ name: 'Standard Swirl', category: 'Swirl', grade: 'mint', type: 'sale', priceCents: 5000, description: 'Handmade', ...over });

test('templates: save, list, and saving the same name again UPDATES it (case-insensitive)', async () => {
  const u = await user('Tpl');
  const first = await request(app).post('/api/templates').set(as(u)).send(tpl());
  assert.equal(first.status, 201);
  const again = await request(app).post('/api/templates').set(as(u)).send(tpl({ name: 'standard SWIRL', priceCents: 9000 }));
  assert.equal(again.status, 200);
  const list = (await request(app).get('/api/templates').set(as(u))).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].price_cents, 9000);
  assert.equal(list[0].id, first.body.id);
});

test('templates validate their input', async () => {
  const u = await user('TplBad');
  for (const bad of [tpl({ name: '' }), tpl({ name: ' ' }), tpl({ name: 'x'.repeat(61) }), tpl({ type: 'raffle' }), tpl({ grade: 'pristine' }),
    tpl({ category: '' }), tpl({ priceCents: -1 }), tpl({ priceCents: 1.5 }), tpl({ priceCents: 'x' }), tpl({ description: 'x'.repeat(1001) })]) {
    const res = await request(app).post('/api/templates').set(as(u)).send(bad);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(bad).slice(0, 70)}`);
  }
  assert.equal((await request(app).get('/api/templates').set(as(u))).body.length, 0);
});

test('at most 20 templates; updating an existing one at the cap still works', async () => {
  const u = await user('TplCap');
  for (let i = 0; i < 20; i++) assert.equal((await request(app).post('/api/templates').set(as(u)).send(tpl({ name: `T${i}` }))).status, 201);
  assert.equal((await request(app).post('/api/templates').set(as(u)).send(tpl({ name: 'T21' }))).status, 409);
  assert.equal((await request(app).post('/api/templates').set(as(u)).send(tpl({ name: 't5', priceCents: 1 }))).status, 200);
});

test('templates are private; you can only delete your own', async () => {
  const [a, b] = [await user('TplA'), await user('TplB')];
  const t = (await request(app).post('/api/templates').set(as(a)).send(tpl())).body;
  assert.equal((await request(app).get('/api/templates').set(as(b))).body.length, 0);
  assert.equal((await request(app).delete(`/api/templates/${t.id}`).set(as(b))).status, 404);
  assert.equal((await request(app).delete(`/api/templates/${t.id}`).set(as(a))).status, 204);
  assert.equal((await request(app).get('/api/templates').set(as(a))).body.length, 0);
  assert.equal((await request(app).delete('/api/templates/not-a-uuid').set(as(a))).status, 404);
  assert.equal((await request(app).get('/api/templates')).status, 401);
});

// ---------------- the dashboard aggregate ----------------
test('a brand-new user gets a clean, complete dashboard', async () => {
  const u = await user('Fresh');
  const d = (await request(app).get('/api/dashboard').set(as(u))).body;
  assert.deepEqual(d.stats, { activeListings: 0, offersSent: 0, posts: 0, battles: 0, roomsHosted: 0, collectionCount: 0 });
  assert.equal(d.challenge.tag, '#SwirlChallenge');
  assert.equal(d.challenge.entries, 0);
  assert.deepEqual(d.achievements, { unlocked: 0, total: 8 });
  assert.equal((await request(app).get('/api/dashboard')).status, 401);
});

test('the dashboard counts what you actually did (and not what others did, or removed things)', async () => {
  const [me, other] = [await user('Me'), await user('Other')];
  const keep = (await listing(me, { name: 'Keep' })).body;
  const drop = (await listing(me, { name: 'Drop' })).body;
  await request(app).patch(`/api/listings/${drop.id}`).set(as(me)).send({ status: 'removed' });
  await listing(other, { name: 'Not Mine' });
  await request(app).post(`/api/listings/${(await listing(other)).body.id}/offers`).set(as(me)).send({ kind: 'offer', offerAmountCents: 100 });
  await request(app).post('/api/feed').set(as(me)).send({ text: 'a post' });
  await request(app).post('/api/feed').set(as(other)).send({ text: 'their post' });
  await request(app).post('/api/rooms').set(as(me)).send({ title: 'R', goLiveNow: true });
  await request(app).post('/api/battles').set(as(me)).send({ opponentId: other.id });
  await request(app).post('/api/collection').set(as(me)).send({ name: 'M1', icon: '🔮', estValueCents: 100 });
  void keep;
  const d = (await request(app).get('/api/dashboard').set(as(me))).body;
  assert.deepEqual(d.stats, { activeListings: 1, offersSent: 1, posts: 1, battles: 1, roomsHosted: 1, collectionCount: 1 });
  assert.equal(d.achievements.unlocked, 5);   // listed, traded, posted, wentLive, challenged (collector needs 3)
});

test('challenge entries count only MY posts that use the weekly tag (any capitalisation)', async () => {
  const [me, other] = [await user('Entrant'), await user('Rival')];
  await request(app).post('/api/feed').set(as(me)).send({ text: '#SwirlChallenge my best' });
  await request(app).post('/api/feed').set(as(me)).send({ text: 'look #swirlchallenge again' });
  await request(app).post('/api/feed').set(as(me)).send({ text: 'no tag here' });
  await request(app).post('/api/feed').set(as(other)).send({ text: '#SwirlChallenge theirs' });
  assert.equal((await request(app).get('/api/dashboard').set(as(me))).body.challenge.entries, 2);
});

test('the dashboard includes game bests', async () => {
  const u = await user('Scores');
  await request(app).post('/api/games/speed/score').set(as(u)).send({ score: 14 });
  await request(app).post('/api/games/trivia/score').set(as(u)).send({ score: 6, outOf: 7 });
  const d = (await request(app).get('/api/dashboard').set(as(u))).body;
  assert.deepEqual(d.games.speed, { best: 14, plays: 1 });
  assert.deepEqual(d.games.trivia, { best: 6, plays: 1 });
});

// ---------------- listing validation (was: a bad value became a database error = HTTP 500) ----------------
test('creating a listing with bad values is a 400, never a 500', async () => {
  const u = await user('Lister');
  for (const bad of [{ type: 'raffle' }, { grade: 'pristine' }, { priceCents: -5 }, { priceCents: 'x' }, { priceCents: 1.5 }, { name: 'x'.repeat(121) }, { description: 'x'.repeat(2001) }, { category: 'x'.repeat(41) }]) {
    const res = await listing(u, bad);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(bad)} (got ${res.status})`);
  }
  assert.equal((await listing(u)).status, 201);
});

test('feed posts and collection items reject absurd values with a 400', async () => {
  const u = await user('Absurd');
  assert.equal((await request(app).post('/api/feed').set(as(u)).send({ text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await request(app).post('/api/feed').set(as(u)).send({ text: 'x'.repeat(2000) })).status, 201);
  for (const bad of [{ name: 'x'.repeat(81) }, { estValueCents: -1 }, { estValueCents: 1.5 }, { estValueCents: 'lots' }, { estValueCents: 2_000_000_001 }]) {
    const res = await request(app).post('/api/collection').set(as(u)).send({ name: 'M', icon: '🔮', estValueCents: 100, ...bad });
    assert.equal(res.status, 400, `collection ${JSON.stringify(bad)} -> ${res.status}`);
  }
  assert.equal((await request(app).post('/api/collection').set(as(u)).send({ name: 'Fine', icon: '🔮', estValueCents: 4200 })).status, 201);
});

test('you cannot challenge yourself, a missing user, or a malformed id (and none of those earn the badge)', async () => {
  const u = await user('Brawler');
  for (const opponentId of [u.id, '00000000-0000-0000-0000-000000000000', 'not-a-uuid', 12345]) {
    const res = await request(app).post('/api/battles').set(as(u)).send({ opponentId });
    assert.ok([400, 404].includes(res.status), `${JSON.stringify(opponentId)} -> ${res.status}`);
  }
  assert.deepEqual(await unlocked(u), []);
});
