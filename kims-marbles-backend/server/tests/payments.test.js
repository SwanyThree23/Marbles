// Stripe Connect, test mode. The Stripe API client is replaced by a recording fake (no
// network, no keys), but webhook signatures are verified by the REAL Stripe library with
// events signed exactly as Stripe signs them. Replaying an event must change nothing.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { resetDb, db, boot, api, user, as, NIL, notes } = require('./helpers');
const stripeMod = require('../stripe');

const WHSEC = 'whsec_test_secret_for_signed_fixture_events';
process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
process.env.APP_URL = 'https://vibenbones.shop';

let calls;
function fakeStripe({ chargesEnabled = true } = {}) {
  calls = [];
  let n = 0;
  return {
    accounts: {
      create: async (p) => { calls.push(['accounts.create', p]); return { id: `acct_test_${++n}` }; },
      retrieve: async (id) => { calls.push(['accounts.retrieve', id]); return { id, charges_enabled: chargesEnabled, details_submitted: chargesEnabled }; },
    },
    accountLinks: { create: async (p) => { calls.push(['accountLinks.create', p]); return { url: 'https://connect.stripe.com/setup/test' }; } },
    checkout: { sessions: { create: async (p) => { calls.push(['checkout.sessions.create', p]); return { id: `cs_test_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}` }; } } },
  };
}

before(boot);
beforeEach(async () => { await resetDb(); stripeMod.setStripeClient(fakeStripe()); });
after(() => db.pool.end());

const signed = (event) => {
  const payload = JSON.stringify(event);
  return { payload, header: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
};
const webhook = ({ payload, header }) => api().post('/api/payments/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload);
const completed = (sessionId, id = `evt_${sessionId}`) => signed({ id, type: 'checkout.session.completed', data: { object: { id: sessionId, payment_status: 'paid' } } });
async function payableHost(handle = 'Host') {
  const h = await user(handle);
  await db.query("update users set stripe_account_id = 'acct_host' where id = $1", [h.id]);
  return h;
}

test('the platform fee is 10%, always rounded down', () => {
  assert.equal(stripeMod.platformFeeCents(1000), 100);
  assert.equal(stripeMod.platformFeeCents(999), 99);
  assert.equal(stripeMod.platformFeeCents(105), 10);
  assert.equal(stripeMod.platformFeeCents(9), 0);
});

test('live Stripe keys are refused unless explicitly allowed', () => {
  assert.throws(() => stripeMod.assertTestModeKey('sk_live_abc'), /live/i);
  assert.doesNotThrow(() => stripeMod.assertTestModeKey('sk_test_abc'));
});

test('onboarding creates one Express account per user and returns Stripe\'s link', async () => {
  const u = await user('Seller');
  const r1 = await api().post('/api/payments/onboard').set(as(u));
  assert.equal(r1.status, 200);
  assert.equal(r1.body.url, 'https://connect.stripe.com/setup/test');
  await api().post('/api/payments/onboard').set(as(u));
  assert.equal(calls.filter((c) => c[0] === 'accounts.create').length, 1, 'a second onboarding reuses the account');
  assert.deepEqual((await api().get('/api/payments/status').set(as(u))).body, { onboarded: true, chargesEnabled: true });
});

test('tips: host without payouts gets a clear message; no tipping yourself; amount $1-$1,000; room must be live', async () => {
  const [h, v] = [await user('Host'), await user('Viewer')];
  const room = (await api().post('/api/rooms').set(as(h)).send({ title: 'R', goLiveNow: true })).body;
  const tip = (u, body) => api().post('/api/payments/tip').set(as(u)).send({ roomId: room.id, amountCents: 500, ...body });
  const noPayouts = await tip(v);
  assert.equal(noPayouts.status, 400);
  assert.match(noPayouts.body.error, /This host has not set up payouts yet/);
  await db.query("update users set stripe_account_id = 'acct_host' where id = $1", [h.id]);
  assert.equal((await tip(h)).status, 400, 'no tipping yourself');
  for (const bad of [{ amountCents: 99 }, { amountCents: 100001 }, { amountCents: 5.5 }, { message: 'x'.repeat(281) }, { roomId: 'nope' }]) {
    assert.equal((await tip(v, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await tip(v, { roomId: NIL })).status, 404);
  await api().patch(`/api/rooms/${room.id}`).set(as(h)).send({ status: 'ended' });
  assert.equal((await tip(v)).status, 409);
});

test('a tip creates a Checkout session paying the host minus 10%, with return URLs to the live room', async () => {
  const [h, v] = [await payableHost(), await user('Viewer')];
  const room = (await api().post('/api/rooms').set(as(h)).send({ title: 'R', goLiveNow: true })).body;
  const res = await api().post('/api/payments/tip').set(as(v)).send({ roomId: room.id, amountCents: 1999, message: 'love the swirls' });
  assert.equal(res.status, 200);
  assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
  const p = calls.find((c) => c[0] === 'checkout.sessions.create')[1];
  assert.equal(p.mode, 'payment');
  assert.equal(p.line_items[0].price_data.unit_amount, 1999);
  assert.equal(p.payment_intent_data.application_fee_amount, 199);
  assert.equal(p.payment_intent_data.transfer_data.destination, 'acct_host');
  assert.equal(p.success_url, `https://vibenbones.shop/live/${room.id}?tip=success`);
  assert.equal(p.cancel_url, `https://vibenbones.shop/live/${room.id}?tip=cancelled`);
  const row = (await db.query('select * from payments')).rows[0];
  assert.deepEqual([row.kind, row.status, row.amount_cents, row.platform_fee_cents, row.payee_id], ['tip', 'pending', 1999, 199, h.id]);
});

test('webhook: an unsigned or wrongly signed request is rejected and changes nothing', async () => {
  const [h, v] = [await payableHost(), await user('Viewer')];
  const room = (await api().post('/api/rooms').set(as(h)).send({ title: 'R', goLiveNow: true })).body;
  await api().post('/api/payments/tip').set(as(v)).send({ roomId: room.id, amountCents: 500 });
  const sid = (await db.query('select stripe_session_id from payments')).rows[0].stripe_session_id;
  const { payload } = completed(sid);
  const forged = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_not_ours' });
  assert.equal((await webhook({ payload, header: forged })).status, 400);
  assert.equal((await api().post('/api/payments/webhook').set('Content-Type', 'application/json').send(payload)).status, 400);
  assert.equal((await db.query('select status from payments')).rows[0].status, 'pending');
});

test('webhook: a paid tip is marked paid and the host is notified ONCE, however many times Stripe delivers it', async () => {
  const [h, v] = [await payableHost(), await user('Viewer')];
  const room = (await api().post('/api/rooms').set(as(h)).send({ title: 'R', goLiveNow: true })).body;
  await api().post('/api/payments/tip').set(as(v)).send({ roomId: room.id, amountCents: 1500, message: 'great show' });
  const sid = (await db.query('select stripe_session_id from payments')).rows[0].stripe_session_id;
  const ev = completed(sid);
  assert.equal((await webhook(ev)).status, 200);
  assert.equal((await webhook(ev)).status, 200, 'a replay is acknowledged (so Stripe stops retrying)');
  const again = completed(sid, 'evt_different_id_same_session');
  assert.equal((await webhook(again)).status, 200);
  const row = (await db.query('select status, paid_at from payments')).rows[0];
  assert.equal(row.status, 'paid');
  assert.ok(row.paid_at);
  const paidNotes = (await notes(h)).filter((n) => n.type === 'payment_received');
  assert.equal(paidNotes.length, 1, `one notification, got ${paidNotes.length}`);
  assert.match(paidNotes[0].text, /Viewer tipped you \$15\.00/);
});

test('webhook: an expired session is marked expired; unknown sessions and event types are acknowledged and ignored', async () => {
  const [h, v] = [await payableHost(), await user('Viewer')];
  const room = (await api().post('/api/rooms').set(as(h)).send({ title: 'R', goLiveNow: true })).body;
  await api().post('/api/payments/tip').set(as(v)).send({ roomId: room.id, amountCents: 500 });
  const sid = (await db.query('select stripe_session_id from payments')).rows[0].stripe_session_id;
  assert.equal((await webhook(signed({ id: 'evt_exp', type: 'checkout.session.expired', data: { object: { id: sid } } }))).status, 200);
  assert.equal((await db.query('select status from payments')).rows[0].status, 'expired');
  assert.equal((await webhook(completed('cs_unknown'))).status, 200);
  assert.equal((await webhook(signed({ id: 'evt_other', type: 'customer.created', data: { object: {} } }))).status, 200);
});

test('checkout for an accepted offer: buyer only; paying it marks the offer paid and the listing sold', async () => {
  const [s, b, o] = [await payableHost('Seller'), await user('Buyer'), await user('Other')];
  const l = (await api().post('/api/listings').set(as(s)).send({ name: 'Lutz', category: 'Vintage', grade: 'mint', type: 'sale', priceCents: 9000 })).body;
  const offer = (await api().post(`/api/listings/${l.id}/offers`).set(as(b)).send({ kind: 'offer', offerAmountCents: 8000 })).body;
  const checkout = (u) => api().post('/api/payments/checkout').set(as(u)).send({ offerId: offer.id });
  assert.equal((await checkout(b)).status, 409, 'the seller has not accepted yet');
  await api().patch(`/api/offers/${offer.id}`).set(as(s)).send({ status: 'accepted' });
  assert.equal((await checkout(o)).status, 403);
  const res = await checkout(b);
  assert.equal(res.status, 200);
  const p = calls.find((c) => c[0] === 'checkout.sessions.create')[1];
  assert.equal(p.line_items[0].price_data.unit_amount, 8000);
  assert.equal(p.payment_intent_data.application_fee_amount, 800);
  const sid = (await db.query('select stripe_session_id from payments')).rows[0].stripe_session_id;
  await webhook(completed(sid));
  assert.equal((await db.query('select status from offers where id = $1', [offer.id])).rows[0].status, 'paid');
  assert.equal((await db.query('select status from listings where id = $1', [l.id])).rows[0].status, 'sold');
  assert.ok((await api().get('/api/achievements').set(as(s))).body.find((x) => x.key === 'traded').unlocked, 'a paid sale earns the seller Trader');
  assert.equal((await api().post('/api/payments/checkout').set(as(b)).send({ offerId: NIL })).status, 404);
});
