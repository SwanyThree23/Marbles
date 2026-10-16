// TURN relay tests — need a real coturn, so they only run when E2E_TURN=1.
//   coturn:  turnserver -c deploy/turnserver.test.conf        (loopback test config)
//   backend: TURN_URLS='turn:127.0.0.1:3478?transport=udp' TURN_SECRET=turn-test-secret MEDIASOUP_ANNOUNCED_IP=127.0.0.1 ...
//   run:     E2E_TURN=1 [TURN_LOG=/path/to/coturn.log] npm run test:browser
//
// The browsers are FORCED to relay-only (iceTransportPolicy 'relay'), so media can
// only flow if the app got valid TURN credentials from the server AND coturn
// accepted them. The negative tests show that is really what is being measured.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { T, startBrowser, stopBrowser, until, newUser, openPage, goLive, joinFromList, tiles, playing, candidateTypes, cleanup } from './helpers.mjs';

const ON = !!process.env.E2E_TURN;
const SECRET = process.env.TURN_SECRET || 'turn-test-secret';
before(async () => { if (ON) await startBrowser(); });
after(async () => { if (ON) await stopBrowser(); });

// join a stream where both sides are forced onto the relay; `tweak(page)` can break the ICE config
async function relayedPair(tweakGuest) {
  const host = await newUser('host'); const guest = await newUser('guest');
  const hostPage = await openPage(host, { relay: true }); await goLive(hostPage);
  const guestPage = await openPage(guest, { relay: true });
  if (tweakGuest) await tweakGuest(guestPage);
  await joinFromList(guestPage, `${host.handle}'s Stream`);
  return { host, guest, hostPage, guestPage };
}
const iceRoute = (page, mutate) => page.route('**/api/rtc/ice-servers', async (route) => {
  const res = await route.fetch(); const body = await res.json();
  await route.fulfill({ response: res, json: mutate(body) });
});
const turnEntry = (body) => body.iceServers.find((s) => s.username);

test('media flows through the TURN relay when direct paths are forbidden', { ...T, skip: !ON }, async () => {
  try {
    const { host, guest, hostPage, guestPage } = await relayedPair();
    await until(async () => (await playing(hostPage, guest.handle)) && (await playing(guestPage, host.handle)), { timeout: 40_000, what: 'relayed video both ways' });
    for (const [who, page] of [['host', hostPage], ['guest', guestPage]]) {
      const pairs = await candidateTypes(page);
      assert.ok(pairs.length >= 2, `${who}: expected a send and a receive pair, got ${JSON.stringify(pairs)}`);
      for (const p of pairs) assert.equal(p.local, 'relay', `${who}: a media path is NOT using the relay: ${JSON.stringify(p)}`);
    }
    if (process.env.TURN_LOG) {                                   // and coturn itself saw both users allocate
      const log = fs.readFileSync(process.env.TURN_LOG, 'utf8');
      for (const u of [host, guest]) assert.ok(log.includes(`:${u.user.id}`), `coturn never saw an allocation for ${u.handle}`);
    }
  } finally { await cleanup(); }
});

test('control: with relay-only and NO ice servers, media does not flow (so the passing test really depends on TURN)', { ...T, skip: !ON }, async () => {
  try {
    const { guest, hostPage } = await relayedPair((p) => iceRoute(p, () => ({ iceServers: [], ttl: 3600 })));
    await new Promise((r) => setTimeout(r, 15_000));
    assert.equal(await playing(hostPage, guest.handle), false, 'media flowed with no TURN servers while forced to relay');
  } finally { await cleanup(); }
});

test('coturn REJECTS a credential signed with the wrong secret', { ...T, skip: !ON }, async () => {
  try {
    const { guest, hostPage } = await relayedPair((p) => iceRoute(p, (b) => {
      const t = turnEntry(b); t.credential = crypto.createHmac('sha1', 'not-the-secret').update(t.username).digest('base64'); return b;
    }));
    await new Promise((r) => setTimeout(r, 15_000));
    assert.equal(await playing(hostPage, guest.handle), false, 'media flowed with a forged credential');
  } finally { await cleanup(); }
});

test('coturn REJECTS an expired credential even though its signature is valid', { ...T, skip: !ON }, async () => {
  try {
    const { guest, hostPage } = await relayedPair((p) => iceRoute(p, (b) => {
      const t = turnEntry(b); const uid = t.username.split(':')[1];
      t.username = `${Math.floor(Date.now() / 1000) - 600}:${uid}`;                       // expired 10 minutes ago
      t.credential = crypto.createHmac('sha1', SECRET).update(t.username).digest('base64'); // ...but correctly signed
      return b;
    }));
    await new Promise((r) => setTimeout(r, 15_000));
    assert.equal(await playing(hostPage, guest.handle), false, 'media flowed with an expired credential');
  } finally { await cleanup(); }
});
