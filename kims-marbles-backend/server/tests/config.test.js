// Boot-time configuration checks: a production server refuses to start with settings that
// would break it or put real money / another product at risk, and says exactly what to fix.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkConfig } = require('../config');

const GOOD = Object.freeze({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://km:pw@127.0.0.1:5432/kims_marbles',
  JWT_SECRET: 'a'.repeat(64),
  APP_URL: 'https://vibenbones.online',
  MEDIASOUP_ANNOUNCED_IP: '203.0.113.10',
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
  TURN_URLS: 'turn:turn.vibenbones.online:3478?transport=udp',
  TURN_SECRET: 'b'.repeat(64),
  METRICS_TOKEN: 'c'.repeat(32),
  SMTP_URL: 'smtps://no-reply%40vibenbones.online:pw@smtp.hostinger.com:465',
});
const errorsOf = (over) => checkConfig({ ...GOOD, ...over }).errors.join('\n');
const warningsOf = (over) => checkConfig({ ...GOOD, ...over }).warnings.join('\n');

test('a complete production config passes with no errors or warnings', () => {
  assert.deepEqual(checkConfig({ ...GOOD }), { errors: [], warnings: [] });
});

test('SeeWhy LIVE\'s database and VPS are refused, in every environment', () => {
  assert.match(errorsOf({ DATABASE_URL: 'postgres://postgres.xlrcibziouffgxciecvc:pw@aws-0.pooler.supabase.com:5432/postgres' }), /SeeWhy/);
  assert.match(errorsOf({ DATABASE_URL: undefined, SUPABASE_DB_URL: 'postgresql://x@db.xlrcibziouffgxciecvc.supabase.co/postgres' }), /SeeWhy/);
  assert.match(errorsOf({ MEDIASOUP_ANNOUNCED_IP: '2.24.194.112' }), /SeeWhy/);
  assert.match(checkConfig({ NODE_ENV: 'development', JWT_SECRET: 'x', DATABASE_URL: 'postgres://u@xlrcibziouffgxciecvc.supabase.co/p' }).errors.join(), /SeeWhy/);
});

test('live Stripe keys are refused unless STRIPE_ALLOW_LIVE=true', () => {
  assert.match(errorsOf({ STRIPE_SECRET_KEY: 'sk_live_abc' }), /live Stripe key/);
  assert.equal(errorsOf({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true' }), '');
  assert.match(errorsOf({ STRIPE_SECRET_KEY: 'rk_live_abc' }), /live Stripe key/);
});

test('required production settings', () => {
  assert.match(errorsOf({ DATABASE_URL: undefined }), /DATABASE_URL/);
  assert.match(errorsOf({ JWT_SECRET: undefined }), /JWT_SECRET/);
  assert.match(errorsOf({ JWT_SECRET: 'short' }), /JWT_SECRET.*32/);
  assert.match(errorsOf({ JWT_SECRET: 'CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME' }), /JWT_SECRET/);
  assert.match(errorsOf({ APP_URL: undefined }), /APP_URL/);
  assert.match(errorsOf({ APP_URL: 'http://vibenbones.online' }), /APP_URL.*https/);
  assert.match(errorsOf({ MEDIASOUP_ANNOUNCED_IP: undefined }), /MEDIASOUP_ANNOUNCED_IP/);
});

test('the announced media IP must be a public IPv4: a private or loopback one means nobody gets video', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.20', '172.20.0.3', '0.0.0.0', 'vibenbones.online', '999.1.1.1']) {
    assert.match(errorsOf({ MEDIASOUP_ANNOUNCED_IP: ip }), /MEDIASOUP_ANNOUNCED_IP/, ip);
  }
  assert.equal(errorsOf({ MEDIASOUP_ANNOUNCED_IP: '89.116.1.2' }), '');
});

test('TURN needs its secret; CORS origins must be https; numbers must be numbers', () => {
  assert.match(errorsOf({ TURN_SECRET: undefined }), /TURN_SECRET/);
  assert.match(errorsOf({ TURN_SECRET: 'short' }), /TURN_SECRET/);
  assert.match(errorsOf({ CORS_ORIGINS: 'http://vibenbones.online' }), /CORS_ORIGINS/);
  assert.equal(errorsOf({ CORS_ORIGINS: 'https://vibenbones.online,https://www.vibenbones.online' }), '');
  assert.match(errorsOf({ PORT: 'eighty' }), /PORT/);
  assert.match(errorsOf({ MEDIASOUP_WORKERS: '0' }), /MEDIASOUP_WORKERS/);
  assert.match(errorsOf({ MEDIASOUP_PORT: '70000' }), /MEDIASOUP_PORT/);
  assert.match(errorsOf({ HOST_GRACE_MS: '10' }), /HOST_GRACE_MS/);
});

test('more than one server process is not supported yet, so REDIS_URL is refused with the reason', () => {
  assert.match(errorsOf({ REDIS_URL: 'redis://localhost:6379' }), /one server process/);
});

test('missing optional pieces are warnings, not errors', () => {
  assert.match(warningsOf({ STRIPE_SECRET_KEY: undefined }), /payments are off/);
  assert.match(warningsOf({ STRIPE_WEBHOOK_SECRET: undefined }), /STRIPE_WEBHOOK_SECRET/);
  assert.match(warningsOf({ TURN_URLS: undefined, TURN_SECRET: undefined }), /TURN/);
  assert.match(warningsOf({ METRICS_TOKEN: undefined }), /METRICS_TOKEN/);
  assert.equal(errorsOf({ STRIPE_SECRET_KEY: undefined, TURN_URLS: undefined, TURN_SECRET: undefined, METRICS_TOKEN: undefined }), '');
});

test('development is relaxed: only a JWT secret is needed', () => {
  assert.deepEqual(checkConfig({ NODE_ENV: 'development', JWT_SECRET: 'dev' }).errors, []);
  assert.match(checkConfig({ NODE_ENV: 'development' }).errors.join(), /JWT_SECRET/);
});

test('errors never echo secret values', () => {
  const all = checkConfig({ ...GOOD, JWT_SECRET: 'tiny-secret-value', TURN_SECRET: 'sh', STRIPE_SECRET_KEY: 'sk_live_supersecret' }).errors.join('\n');
  for (const secret of ['tiny-secret-value', 'sk_live_supersecret']) assert.ok(!all.includes(secret), `leaked ${secret}`);
});

test('the real server refuses to boot with a bad production config and lists every problem', async () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production', JWT_SECRET: 'short', STRIPE_SECRET_KEY: 'sk_live_x' },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(r.status, 1);
  for (const what of ['DATABASE_URL', 'JWT_SECRET', 'APP_URL', 'MEDIASOUP_ANNOUNCED_IP', 'live Stripe key']) assert.match(r.stderr, new RegExp(what));
});

test('email: optional (a warning that password reset is off), but a malformed SMTP_URL is an error that does not echo the password', () => {
  assert.match(warningsOf({ SMTP_URL: undefined }), /password reset/);
  const e = errorsOf({ SMTP_URL: 'http://user:hunter2-secret@mail.example.com' });
  assert.match(e, /SMTP_URL/);
  assert.ok(!e.includes('hunter2-secret'));
  assert.equal(errorsOf({ SMTP_URL: 'smtp://127.0.0.1:2525' }), '');
});
