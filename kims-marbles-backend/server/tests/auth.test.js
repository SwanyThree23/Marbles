// Register, login and who-am-I, against a real Postgres.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { resetDb, db } = require('./setup');

let request; let app;
before(async () => { request = (await import('supertest')).default; app = require('../app'); });
beforeEach(resetDb);
after(() => db.pool.end());

const register = (body) => request(app).post('/api/auth/register').send(body);
const good = { handle: 'GlassTrader', email: 'glass@example.com', password: 'password123' };

test('register returns the user and a working token pair; the password is never stored or returned', async () => {
  const res = await register(good);
  assert.equal(res.status, 201);
  assert.equal(res.body.user.handle, 'GlassTrader');
  assert.equal(res.body.user.password_hash, undefined);
  assert.equal(res.body.user.email, undefined, 'email is private and not echoed in the public user object');
  assert.ok(res.body.accessToken && res.body.refreshToken);
  const claims = jwt.verify(res.body.accessToken, process.env.JWT_SECRET);
  assert.equal(claims.sub, res.body.user.id);
  const row = (await db.query('select password_hash from users where id = $1', [res.body.user.id])).rows[0];
  assert.ok(row.password_hash.startsWith('$2'), 'stored as a bcrypt hash');
  assert.ok(!row.password_hash.includes('password123'));
});

test('register validates input', async () => {
  for (const bad of [
    { ...good, handle: 'ab' }, { ...good, handle: 'has space' }, { ...good, handle: 'x'.repeat(25) },
    { ...good, email: 'not-an-email' }, { ...good, password: 'short' }, { ...good, password: 'x'.repeat(201) },
    { handle: 'NoEmail', password: 'password123' }, {},
  ]) {
    const res = await register(bad);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(bad)}`);
    assert.ok(res.body.error);
  }
});

test('handles and emails are unique regardless of capitalisation', async () => {
  assert.equal((await register(good)).status, 201);
  assert.equal((await register({ ...good, email: 'other@example.com', handle: 'glasstrader' })).status, 409);
  assert.equal((await register({ ...good, handle: 'Someone', email: 'GLASS@example.com' })).status, 409);
});

test('login: right password works (email any case), wrong password and unknown email look identical', async () => {
  await register(good);
  const ok = await request(app).post('/api/auth/login').send({ email: 'Glass@Example.com', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken && ok.body.refreshToken);
  const wrong = await request(app).post('/api/auth/login').send({ email: good.email, password: 'nope-nope-nope' });
  const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'password123' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body, 'must not reveal which emails exist');
});

test('GET /api/auth/me needs a valid, unexpired token signed with our secret', async () => {
  const { body } = await register(good);
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.accessToken}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.handle, 'GlassTrader');
  assert.equal(me.body.email, 'glass@example.com', 'your own email is visible to you');
  assert.equal((await request(app).get('/api/auth/me')).status, 401);
  const forged = jwt.sign({ sub: body.user.id }, 'some-other-secret');
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status, 401);
  const expired = jwt.sign({ sub: body.user.id }, process.env.JWT_SECRET, { expiresIn: -10 });
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`)).status, 401);
  const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: body.user.id })).toString('base64url')}.`;
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${noneAlg}`)).status, 401);
});

test('a token for a deleted account is refused', async () => {
  const { body } = await register(good);
  await db.query('delete from users where id = $1', [body.user.id]);
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.accessToken}`)).status, 401);
});

test('/health answers without a login', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('unknown API routes are a JSON 404, malformed JSON is a 400, never a 500', async () => {
  const res = await request(app).get('/api/nope');
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
  const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
  assert.equal(bad.status, 400);
});
