// PK-battles: challenge, accept/decline, gifts, ending, leaderboard. Who may do what.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db, boot, api, user, as, NIL, notes } = require('./helpers');

before(boot);
beforeEach(resetDb);
after(() => db.pool.end());

const challenge = (u, body) => api().post('/api/battles').set(as(u)).send(body);
const act = (u, id, verb, body) => api().post(`/api/battles/${id}/${verb}`).set(as(u)).send(body || {});
async function liveBattle() {
  const [a, b, fan] = [await user('Alice'), await user('Bobby'), await user('Fan')];
  const battle = (await challenge(a, { opponentId: b.id, roundSeconds: 120 })).body;
  await act(b, battle.id, 'accept');
  return { a, b, fan, battle };
}

test('a challenge is validated, notifies the opponent, and defaults to points', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  for (const bad of [{ opponentId: b.id, roundSeconds: 30 }, { opponentId: b.id, roundSeconds: 99999 }, { opponentId: b.id, wagerType: 'cash' },
    { opponentId: b.id, wagerType: 'marble' }, { opponentId: b.id, wagerType: 'marble', wagerItemId: NIL }]) {
    assert.equal((await challenge(a, bad)).status, 400, JSON.stringify(bad));
  }
  const res = await challenge(a, { opponentId: b.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.wager_type, 'points');
  const n = await notes(b);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, 'challenge');
  assert.equal(n[0].ref_id, res.body.id);
});

test('a marble wager must be a marble you own', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  const mine = (await db.query("insert into collection_items (owner_id, name) values ($1, 'Mine') returning id", [a.id])).rows[0].id;
  const theirs = (await db.query("insert into collection_items (owner_id, name) values ($1, 'Theirs') returning id", [b.id])).rows[0].id;
  assert.equal((await challenge(a, { opponentId: b.id, wagerType: 'marble', wagerItemId: theirs })).status, 400);
  assert.equal((await challenge(a, { opponentId: b.id, wagerType: 'marble', wagerItemId: mine })).status, 201);
});

test('only the opponent accepts or declines, and only while pending; the challenger hears back', async () => {
  const [a, b, c] = [await user('Alice'), await user('Bobby'), await user('Carol')];
  const battle = (await challenge(a, { opponentId: b.id })).body;
  assert.equal((await act(a, battle.id, 'accept')).status, 403);
  assert.equal((await act(c, battle.id, 'accept')).status, 403);
  const ok = await act(b, battle.id, 'accept');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'live');
  assert.ok(ok.body.started_at);
  assert.equal((await act(b, battle.id, 'decline')).status, 409, 'already live');
  assert.equal((await notes(a)).at(-1).type, 'challenge_accepted');
  const second = (await challenge(a, { opponentId: b.id })).body;
  assert.equal((await act(b, second.id, 'decline')).body.status, 'declined');
  assert.equal((await act(b, NIL, 'accept')).status, 404);
  assert.equal((await act(b, 'not-a-uuid', 'accept')).status, 404);
});

test('gifts: only on a live battle, validated, and they move the score', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  const pending = (await challenge(a, { opponentId: b.id })).body;
  const fan = await user('Fan');
  assert.equal((await act(fan, pending.id, 'gift', { side: 'challenger', giftName: 'Swirl', points: 150 })).status, 409);
  await act(b, pending.id, 'accept');
  for (const bad of [{ side: 'middle', giftName: 'x', points: 1 }, { side: 'challenger', giftName: '', points: 1 },
    { side: 'challenger', giftName: 'x', points: 0 }, { side: 'challenger', giftName: 'x', points: 10001 }, { side: 'challenger', giftName: 'x', points: 1.5 }]) {
    assert.equal((await act(fan, pending.id, 'gift', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await act(fan, pending.id, 'gift', { side: 'challenger', giftName: 'Swirl', points: 150 })).status, 201);
  const g = await act(fan, pending.id, 'gift', { side: 'opponent', giftName: 'Rare Mega', points: 300 });
  assert.deepEqual([g.body.challenger_points, g.body.opponent_points], [150, 300]);
});

test('only the two battlers end a battle, only while live, and the winner is the higher score', async () => {
  const { a, b, fan, battle } = await liveBattle();
  await act(fan, battle.id, 'gift', { side: 'opponent', giftName: 'Oxblood', points: 50 });
  assert.equal((await act(fan, battle.id, 'end')).status, 403);
  const end = await act(a, battle.id, 'end');
  assert.equal(end.status, 200);
  assert.equal(end.body.status, 'ended');
  assert.equal(end.body.winner_id, b.id);
  assert.equal((await act(b, battle.id, 'end')).status, 409, "an ended battle's winner cannot be rewritten");
});

test('a tied battle has no winner', async () => {
  const { a, battle } = await liveBattle();
  assert.equal((await act(a, battle.id, 'end')).body.winner_id, null);
});

test('leaderboard: public, collectors ranked by gift points received', async () => {
  const { a, b, fan, battle } = await liveBattle();
  await act(fan, battle.id, 'gift', { side: 'challenger', giftName: 'Swirl', points: 150 });
  await act(fan, battle.id, 'gift', { side: 'opponent', giftName: 'Oxblood', points: 50 });
  const lb = await api().get('/api/battles/leaderboard');
  assert.equal(lb.status, 200);
  assert.deepEqual(lb.body.map((r) => [r.handle, r.points]), [[a.handle, 150], [b.handle, 50]]);
});

test('GET /api/battles?mine=1 lists my battles with both handles', async () => {
  const { a, battle } = await liveBattle();
  const [c, d] = [await user('Carol'), await user('David')];
  await challenge(c, { opponentId: d.id });
  const mine = (await api().get('/api/battles?mine=1').set(as(a))).body;
  assert.deepEqual(mine.map((x) => x.id), [battle.id]);
  assert.equal(mine[0].challenger_handle, 'Alice');
  assert.equal(mine[0].opponent_handle, 'Bobby');
});
