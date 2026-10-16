// The token bucket behind socket flood protection. Pure logic, injectable clock.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { takeToken, resetBuckets, limited } = require('../socketGuard');

beforeEach(resetBuckets);
const RULE = { burst: 3, perSec: 1 };

test('allows a burst up to its capacity, then refuses', () => {
  const t = 1_000_000;
  assert.equal(takeToken('k', RULE, t).ok, true);
  assert.equal(takeToken('k', RULE, t).ok, true);
  assert.equal(takeToken('k', RULE, t).ok, true);
  const fourth = takeToken('k', RULE, t);
  assert.equal(fourth.ok, false);
  assert.ok(fourth.retryMs > 0 && fourth.retryMs <= 1000, `retryMs ${fourth.retryMs} should be about one refill interval`);
});

test('refills steadily: one token per second at perSec=1', () => {
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) takeToken('k', RULE, t);
  assert.equal(takeToken('k', RULE, t + 500).ok, false);     // half a second: not yet
  assert.equal(takeToken('k', RULE, t + 1000).ok, true);     // a full second: one token back
  assert.equal(takeToken('k', RULE, t + 1000).ok, false);    // ...and only one
});

test('never accumulates more than the burst, however long it sits idle', () => {
  const t = 1_000_000;
  takeToken('k', RULE, t);
  const later = t + 3_600_000;                                // an hour later
  const results = [1, 2, 3, 4].map(() => takeToken('k', RULE, later).ok);
  assert.deepEqual(results, [true, true, true, false]);
});

test('keys are independent: one user flooding does not use up another\'s budget', () => {
  const t = 1_000_000;
  for (let i = 0; i < 10; i++) takeToken('alice', RULE, t);
  assert.equal(takeToken('bob', RULE, t).ok, true);
});

test('a slow, steady sender is never limited', () => {
  let t = 1_000_000;
  for (let i = 0; i < 100; i++) { assert.equal(takeToken('k', RULE, t).ok, true, `message ${i}`); t += 1000; }
});

test('limited(): runs the handler while under the limit, calls onLimit (not the handler) over it', () => {
  const socket = { id: 's1', user: { id: 'u1' } };
  const ran = []; const limitedCalls = [];
  const fn = limited(socket, 'chat', RULE, (p) => ran.push(p), (ms) => limitedCalls.push(ms));
  for (let i = 0; i < 5; i++) fn({ i });
  assert.equal(ran.length, 3);
  assert.equal(limitedCalls.length, 2);
});

test('limited(): a logged-in user shares ONE budget across all their sockets', () => {
  const rule = { burst: 2, perSec: 0.001 };
  const a = limited({ id: 'sA', user: { id: 'u1' } }, 'chat', rule, () => 'ok', () => 'limited');
  const b = limited({ id: 'sB', user: { id: 'u1' } }, 'chat', rule, () => 'ok', () => 'limited');
  assert.equal(a(), 'ok'); assert.equal(a(), 'ok');
  assert.equal(b(), undefined, 'a second socket must not give the same user a fresh budget');
});

test('limited(): anonymous sockets are limited per socket', () => {
  const rule = { burst: 1, perSec: 0.001 };
  const a = limited({ id: 'sA' }, 'react', rule, () => 'ok');
  const b = limited({ id: 'sB' }, 'react', rule, () => 'ok');
  assert.equal(a(), 'ok'); assert.equal(a(), undefined);
  assert.equal(b(), 'ok');
});
