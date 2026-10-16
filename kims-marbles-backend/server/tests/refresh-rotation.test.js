// Refresh tokens: stored hashed, rotate on every use, replay of a retired token kills the
// whole login (family), a 10 s grace window for benign double-refreshes, real logout.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { resetDb, db } = require('./setup');

let request; let app; let auth;
before(async () => { request = (await import('supertest')).default; app = require('../app'); auth = require('../routes/auth'); });
beforeEach(resetDb);
after(() => db.pool.end());

const login = async (handle = 'Rotator') => {
  const r = await request(app).post('/api/auth/register').send({ handle, email: `${handle.toLowerCase()}@x.com`, password: 'password123' });
  return r.body;
};
const refresh = (refreshToken) => request(app).post('/api/auth/refresh').send({ refreshToken });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const ageRotation = (token, seconds) =>
  db.query("update refresh_tokens set revoked_at = now() - make_interval(secs => $2) where token_hash = $1", [sha(token), seconds]);

test('only the sha-256 hash of a refresh token is stored', async () => {
  const s = await login();
  const rows = (await db.query('select token_hash from refresh_tokens')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha(s.refreshToken));
  assert.ok(!JSON.stringify(rows).includes(s.refreshToken));
});

test('refresh rotates: a new pair comes back, and the old token is retired', async () => {
  const s = await login();
  const r1 = await refresh(s.refreshToken);
  assert.equal(r1.status, 200);
  assert.ok(r1.body.accessToken && r1.body.refreshToken);
  assert.notEqual(r1.body.refreshToken, s.refreshToken);
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${r1.body.accessToken}`);
  assert.equal(me.status, 200);
  const r2 = await refresh(r1.body.refreshToken);
  assert.equal(r2.status, 200, 'the rotated token works');
});

test('REUSE: replaying a retired token after the grace window revokes the whole login, thief and owner alike', async () => {
  const s = await login();
  const r1 = await refresh(s.refreshToken);
  await ageRotation(s.refreshToken, 60);
  const replay = await refresh(s.refreshToken);
  assert.equal(replay.status, 401);
  assert.equal((await refresh(r1.body.refreshToken)).status, 401, 'the newest token in the family must also be dead');
});

test('reuse detection is per login: another device of the same user is unaffected', async () => {
  const s = await login();
  const other = (await request(app).post('/api/auth/login').send({ email: 'rotator@x.com', password: 'password123' })).body;
  await refresh(s.refreshToken);
  await ageRotation(s.refreshToken, 60);
  await refresh(s.refreshToken);                     // reuse: kills the first login only
  assert.equal((await refresh(other.refreshToken)).status, 200);
});

test('GRACE: a token rotated moments ago may be presented again (two tabs refreshing at once)', async () => {
  const s = await login();
  const first = await refresh(s.refreshToken);
  const second = await refresh(s.refreshToken);      // within 10 s of its rotation
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await refresh(first.body.refreshToken)).status, 200);
  assert.equal((await refresh(second.body.refreshToken)).status, 200);
});

test('unknown, malformed, expired and missing refresh tokens are 401 (missing is 400)', async () => {
  const s = await login();
  assert.equal((await refresh('not-a-real-token')).status, 401);
  assert.equal((await refresh(12345)).status, 400);
  assert.equal((await request(app).post('/api/auth/refresh').send({})).status, 400);
  await db.query("update refresh_tokens set expires_at = now() - interval '1 minute'");
  assert.equal((await refresh(s.refreshToken)).status, 401);
});

test('logout revokes that login on the server (no grace), always 204', async () => {
  const s = await login();
  const res = await request(app).post('/api/auth/logout').send({ refreshToken: s.refreshToken });
  assert.equal(res.status, 204);
  assert.equal((await refresh(s.refreshToken)).status, 401);
  assert.equal((await request(app).post('/api/auth/logout').send({ refreshToken: 'garbage' })).status, 204);
  assert.equal((await request(app).post('/api/auth/logout').send({})).status, 204);
});

test('logout after a rotation kills the rotated token too (the whole family)', async () => {
  const s = await login();
  const r1 = await refresh(s.refreshToken);
  await request(app).post('/api/auth/logout').send({ refreshToken: r1.body.refreshToken });
  assert.equal((await refresh(r1.body.refreshToken)).status, 401);
  assert.equal((await refresh(s.refreshToken)).status, 401, 'no grace for a logged-out family');
});

test('logout-all revokes every login of that user and no one else\'s', async () => {
  const a1 = await login('Alice');
  const a2 = (await request(app).post('/api/auth/login').send({ email: 'alice@x.com', password: 'password123' })).body;
  const b = await login('Bobby');
  assert.equal((await request(app).post('/api/auth/logout-all')).status, 401);
  const res = await request(app).post('/api/auth/logout-all').set('Authorization', `Bearer ${a1.accessToken}`);
  assert.equal(res.status, 204);
  assert.equal((await refresh(a1.refreshToken)).status, 401);
  assert.equal((await refresh(a2.refreshToken)).status, 401);
  assert.equal((await refresh(b.refreshToken)).status, 200);
});

test('GRACE_SECONDS is 10 and refresh tokens live 30 days', async () => {
  assert.equal(auth.GRACE_SECONDS, 10);
  const s = await login();
  const row = (await db.query("select extract(epoch from expires_at - created_at)::int as secs from refresh_tokens where token_hash = $1", [sha(s.refreshToken)])).rows[0];
  assert.ok(Math.abs(row.secs - 30 * 86400) < 5);
});
