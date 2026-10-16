// Marketplace: listings, offers, auction bids (row-locked), owner-only edits.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, db } = require('./setup');

let request; let app;
before(async () => { request = (await import('supertest')).default; app = require('../app'); });
beforeEach(resetDb);
after(() => db.pool.end());

async function user(handle) {
  const r = await request(app).post('/api/auth/register').send({ handle, email: `${handle.toLowerCase()}@x.com`, password: 'password123' });
  return { token: r.body.accessToken, id: r.body.user.id, handle };
}
const as = (u) => ({ Authorization: `Bearer ${u.token}` });
const create = (u, over = {}) => request(app).post('/api/listings').set(as(u))
  .send({ name: 'Oxblood Swirl', category: 'Swirl', grade: 'mint', type: 'sale', priceCents: 8500, description: '1920s', ...over });
const NIL = '00000000-0000-0000-0000-000000000000';

test('anyone can browse active listings, newest first, with the seller handle and prices in cents', async () => {
  const s = await user('Seller');
  await create(s, { name: 'First' });
  await create(s, { name: 'Second', priceCents: 1234 });
  const res = await request(app).get('/api/listings');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((l) => l.name), ['Second', 'First']);
  assert.equal(res.body[0].seller_handle, 'Seller');
  assert.equal(res.body[0].price_cents, 1234);
  assert.equal(res.body[0].seller_email, undefined);
});

test('filters by category, type and a case-insensitive name search; % and _ are literal', async () => {
  const s = await user('Seller');
  await create(s, { name: 'Blue Swirl', category: 'Swirl' });
  await create(s, { name: 'Akro Sulphide', category: 'Sulphide' });
  await create(s, { name: '100% Lutz', category: 'Vintage', type: 'auction' });
  const names = async (q) => (await request(app).get(`/api/listings?${q}`)).body.map((l) => l.name).sort();
  assert.deepEqual(await names('category=Swirl'), ['Blue Swirl']);
  assert.deepEqual(await names('type=auction'), ['100% Lutz']);
  assert.deepEqual(await names('q=sulph'), ['Akro Sulphide']);
  assert.deepEqual(await names('q=%25'), ['100% Lutz'], 'a % in the search is a literal %, not a wildcard');
  assert.deepEqual(await names('q=_'), []);
});

test('creating needs a login and validates every field (400, never 500)', async () => {
  const s = await user('Seller');
  assert.equal((await request(app).post('/api/listings').send({ name: 'x' })).status, 401);
  for (const bad of [{ name: '' }, { name: 'x'.repeat(121) }, { type: 'raffle' }, { grade: 'pristine' }, { category: '' },
    { category: 'x'.repeat(41) }, { priceCents: -5 }, { priceCents: 1.5 }, { priceCents: 'x' }, { priceCents: 100_000_001 },
    { description: 'x'.repeat(2001) }, { type: 'auction', auctionEndsInMinutes: 0 }, { type: 'auction', auctionEndsInMinutes: 99999 }]) {
    const res = await create(s, bad);
    assert.equal(res.status, 400, `should reject ${JSON.stringify(bad)} (got ${res.status})`);
  }
  assert.equal((await request(app).get('/api/listings')).body.length, 0);
});

test('an auction starts at its starting price and ends at the requested time', async () => {
  const s = await user('Seller');
  const l = (await create(s, { type: 'auction', priceCents: 2000, auctionEndsInMinutes: 30 })).body;
  assert.equal(l.current_bid_cents, 2000);
  const mins = (new Date(l.ends_at) - Date.now()) / 60000;
  assert.ok(mins > 29 && mins <= 30, `ends in ${mins} minutes`);
});

test('only the seller can change or remove a listing; unknown and malformed ids are 404', async () => {
  const [s, o] = [await user('Seller'), await user('Other')];
  const l = (await create(s)).body;
  assert.equal((await request(app).patch(`/api/listings/${l.id}`).set(as(o)).send({ status: 'sold' })).status, 403);
  assert.equal((await request(app).delete(`/api/listings/${l.id}`).set(as(o))).status, 403);
  assert.equal((await request(app).patch(`/api/listings/${NIL}`).set(as(s)).send({ status: 'sold' })).status, 404);
  assert.equal((await request(app).patch('/api/listings/not-a-uuid').set(as(s)).send({ status: 'sold' })).status, 404);
  assert.equal((await request(app).patch(`/api/listings/${l.id}`).set(as(s)).send({ status: 'stolen' })).status, 400);
  const sold = await request(app).patch(`/api/listings/${l.id}`).set(as(s)).send({ status: 'sold' });
  assert.equal(sold.status, 200);
  assert.equal(sold.body.status, 'sold');
  assert.equal((await request(app).get('/api/listings')).body.length, 0, 'sold listings leave the marketplace');
  const l2 = (await create(s)).body;
  assert.equal((await request(app).delete(`/api/listings/${l2.id}`).set(as(s))).status, 204);
  assert.equal((await request(app).get('/api/listings')).body.length, 0);
});

test('offers: validated, not on your own listing, only on active listings; the seller is notified', async () => {
  const [s, b] = [await user('Seller'), await user('Buyer')];
  const l = (await create(s)).body;
  const offer = (u, body) => request(app).post(`/api/listings/${l.id}/offers`).set(as(u)).send(body);
  for (const bad of [{ kind: 'steal' }, { kind: 'offer' }, { kind: 'offer', offerAmountCents: -1 }, { kind: 'offer', offerAmountCents: 1.5 },
    { kind: 'trade', tradeItemIds: 'nope' }, { kind: 'trade', tradeItemIds: ['not-a-uuid'] }, { kind: 'trade', tradeItemIds: [] }]) {
    assert.equal((await offer(b, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await offer(s, { kind: 'offer', offerAmountCents: 100 })).status, 403, 'no offers on your own listing');
  const ok = await offer(b, { kind: 'offer', offerAmountCents: 7000, message: 'would you take 70?' });
  assert.equal(ok.status, 201);
  const notes = (await db.query('select * from notifications where user_id = $1', [s.id])).rows;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'offer_received');
  assert.match(notes[0].text, /Buyer/);
  await request(app).patch(`/api/listings/${l.id}`).set(as(s)).send({ status: 'sold' });
  assert.equal((await offer(b, { kind: 'offer', offerAmountCents: 7000 })).status, 409, 'no offers on a sold listing');
  assert.equal((await request(app).post(`/api/listings/${NIL}/offers`).set(as(b)).send({ kind: 'buy' })).status, 404);
});

test('a trade offer may only offer marbles the buyer actually owns', async () => {
  const [s, b] = [await user('Seller'), await user('Buyer')];
  const l = (await create(s, { type: 'trade' })).body;
  const mine = (await db.query("insert into collection_items (owner_id, name) values ($1, 'Mine') returning id", [b.id])).rows[0].id;
  const theirs = (await db.query("insert into collection_items (owner_id, name) values ($1, 'Theirs') returning id", [s.id])).rows[0].id;
  const offer = (ids) => request(app).post(`/api/listings/${l.id}/offers`).set(as(b)).send({ kind: 'trade', tradeItemIds: ids });
  assert.equal((await offer([theirs])).status, 400);
  assert.equal((await offer([mine, theirs])).status, 400);
  assert.equal((await offer([mine])).status, 201);
});

test('bids: auctions only, not your own, must beat the current bid by the increment, and not after it ends', async () => {
  const [s, b, c] = [await user('Seller'), await user('BidderB'), await user('BidderC')];
  const a = (await create(s, { type: 'auction', priceCents: 2000 })).body;
  const sale = (await create(s)).body;
  const bid = (u, id, amountCents) => request(app).post(`/api/listings/${id}/bids`).set(as(u)).send({ amountCents });
  assert.equal((await bid(b, sale.id, 9999)).status, 400, 'not an auction');
  assert.equal((await bid(s, a.id, 9999)).status, 403, 'no bidding on your own auction');
  assert.equal((await bid(b, a.id, 1999)).status, 400, 'below the starting price');
  const first = await bid(b, a.id, 2000);
  assert.equal(first.status, 201, 'the first bid may equal the starting price');
  assert.equal(first.body.currentBidCents, 2000);
  assert.equal((await bid(c, a.id, 2499)).status, 400, 'must beat the current bid by the 500-cent increment');
  assert.equal((await bid(c, a.id, 2500)).status, 201);
  for (const bad of [-1, 1.5, 'lots', null]) assert.equal((await bid(c, a.id, bad)).status, 400);
  await db.query("update listings set ends_at = now() - interval '1 second' where id = $1", [a.id]);
  assert.equal((await bid(b, a.id, 9000)).status, 409, 'the auction has ended');
  const row = (await db.query('select current_bid_cents, current_bidder_id from listings where id = $1', [a.id])).rows[0];
  assert.deepEqual(row, { current_bid_cents: 2500, current_bidder_id: c.id });
});

test('eight people bidding the same amount at the same instant: exactly one wins (row lock)', async () => {
  const s = await user('Seller');
  const bidders = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => user(`Bidder${i}`)));
  const a = (await create(s, { type: 'auction', priceCents: 1000 })).body;
  const results = await Promise.all(bidders.map((u) => request(app).post(`/api/listings/${a.id}/bids`).set(as(u)).send({ amountCents: 1000 })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((x) => x === 201).length, 1, `exactly one bid may win: ${statuses}`);
  assert.equal((await db.query('select count(*)::int as n from bids')).rows[0].n, 1);
});
