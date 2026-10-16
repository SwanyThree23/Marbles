// GET /api/rtc/ice-servers: short-lived coturn credentials (TURN REST API scheme).
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { resetDb, db, boot, api, user, as } = require('./helpers');

before(boot);
beforeEach(async () => {
  await resetDb();
  for (const k of ['STUN_URLS', 'TURN_URLS', 'TURN_SECRET', 'TURN_TTL_SECONDS']) delete process.env[k];
});
after(() => db.pool.end());

test('login required; with nothing configured the list is empty, never cached', async () => {
  assert.equal((await api().get('/api/rtc/ice-servers')).status, 401);
  const u = await user('Viewer');
  const r = await api().get('/api/rtc/ice-servers').set(as(u));
  assert.deepEqual(r.body, { iceServers: [], ttl: 3600 });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('TURN credentials: username "<expiry>:<userId>", credential = base64 HMAC-SHA1; the secret is never sent', async () => {
  process.env.STUN_URLS = 'stun:stun.example.com:3478';
  process.env.TURN_URLS = 'turn:turn.example.com:3478?transport=udp, turns:turn.example.com:5349?transport=tcp, http://evil.example';
  process.env.TURN_SECRET = 'turn-test-secret';
  process.env.TURN_TTL_SECONDS = '600';
  const u = await user('Viewer');
  const r = (await api().get('/api/rtc/ice-servers').set(as(u))).body;
  assert.equal(r.ttl, 600);
  assert.deepEqual(r.iceServers[0], { urls: ['stun:stun.example.com:3478'] });
  const turn = r.iceServers[1];
  assert.deepEqual(turn.urls, ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'], 'non-TURN urls are dropped');
  const [expiry, uid] = turn.username.split(':');
  assert.equal(uid, u.id);
  assert.ok(Math.abs(Number(expiry) - (Date.now() / 1000 + 600)) < 5);
  assert.equal(turn.credential, crypto.createHmac('sha1', 'turn-test-secret').update(turn.username).digest('base64'));
  assert.ok(!JSON.stringify(r).includes('turn-test-secret'));
});

test('TTL is clamped to 60 s .. 24 h; TURN without a secret issues nothing', async () => {
  const u = await user('Viewer');
  process.env.TURN_URLS = 'turn:t.example.com:3478';
  assert.deepEqual((await api().get('/api/rtc/ice-servers').set(as(u))).body.iceServers, []);
  process.env.TURN_SECRET = 's';
  process.env.TURN_TTL_SECONDS = '5';
  assert.equal((await api().get('/api/rtc/ice-servers').set(as(u))).body.ttl, 60);
  process.env.TURN_TTL_SECONDS = '999999';
  assert.equal((await api().get('/api/rtc/ice-servers').set(as(u))).body.ttl, 86400);
});
