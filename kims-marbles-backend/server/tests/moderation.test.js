// Live-chat moderation: the blocked-word matcher, the settings API, and cache invalidation.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db, boot, api, user, as } = require('./helpers');
const { findBlockedWord, getRoomModeration } = require('../socketGuard');

before(boot);
beforeEach(resetDb);
after(() => db.pool.end());

test('matcher: whole words, any case; not inside other words', () => {
  assert.equal(findBlockedWord('You absolute SCAMMER', ['scammer']), 'scammer');
  assert.equal(findBlockedWord('a spamless lovely day', ['spam']), null);
  assert.equal(findBlockedWord('first class assist', ['ass']), null);
  assert.equal(findBlockedWord('spam!', ['spam']), 'spam');
  assert.equal(findBlockedWord('free money now', ['free money']), 'free money', 'phrases match as a whole');
  assert.equal(findBlockedWord('Ünïcode wörd here', ['wörd']), 'wörd');
});

test('matcher: symbols and emoji match as substrings; regex characters are inert', () => {
  assert.equal(findBlockedWord('visit http://scam.example', ['http://']), 'http://');
  assert.equal(findBlockedWord('nice 🍆 lol', ['🍆']), '🍆');
  assert.equal(findBlockedWord('anything at all', ['.*']), null);
  assert.equal(findBlockedWord('a.*b', ['.*']), '.*');
  assert.equal(findBlockedWord('(((', ['(']), '(');
  assert.equal(findBlockedWord('', ['x']), null);
  assert.equal(findBlockedWord('text', []), null);
});

test('settings default to off and empty; mine only; login required', async () => {
  const a = await user('Alice');
  assert.deepEqual((await api().get('/api/moderation').set(as(a))).body, { enabled: false, words: [] });
  assert.equal((await api().get('/api/moderation')).status, 401);
});

test('PUT trims, lowercases, de-duplicates and drops blanks; each user has their own list', async () => {
  const [a, b] = [await user('Alice'), await user('Bobby')];
  const r = await api().put('/api/moderation').set(as(a)).send({ enabled: true, words: ['  Scammer ', 'SPAM', 'spam', '', '  '] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { enabled: true, words: ['scammer', 'spam'] });
  assert.deepEqual((await api().get('/api/moderation').set(as(a))).body, { enabled: true, words: ['scammer', 'spam'] });
  assert.deepEqual((await api().get('/api/moderation').set(as(b))).body, { enabled: false, words: [] });
});

test('PUT rejects bad input with 400', async () => {
  const a = await user('Alice');
  for (const bad of [{ enabled: 'yes', words: [] }, { enabled: true, words: 'spam' }, { enabled: true, words: [42] },
    { enabled: true, words: ['x'.repeat(41)] }, { enabled: true, words: Array.from({ length: 101 }, (_, i) => `w${i}`) }, {}]) {
    assert.equal((await api().put('/api/moderation').set(as(a)).send(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('saving invalidates the per-room cache at once (no 10 s wait)', async () => {
  const h = await user('Host');
  const room = (await api().post('/api/rooms').set(as(h)).send({ title: 'R', goLiveNow: true })).body;
  assert.deepEqual((await getRoomModeration(room.id)).words, []);           // now cached
  await api().put('/api/moderation').set(as(h)).send({ enabled: true, words: ['scammer'] });
  const fresh = await getRoomModeration(room.id);
  assert.equal(fresh.enabled, true);
  assert.deepEqual(fresh.words, ['scammer']);
});
