// Marketplace: listings, offers and auction bids.
const express = require('express');
const db = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isInt, isStr, LISTING_TYPES, LISTING_GRADES, MAX_PRICE_CENTS } = require('../validate');
const { award } = require('../achievements');
const { recordActivity } = require('../activity');
const { notify } = require('../notify');

const router = express.Router();
const money = (c) => `$${(c / 100).toFixed(2)}`;
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const LIST_COLUMNS = `l.*, u.handle as seller_handle`;

// GET /api/listings?category=&type=&q=   active listings, newest first
router.get('/', optionalAuth, async (req, res, next) => {
  const { category, type, q } = req.query;
  const where = ["l.status = 'active'"]; const params = [];
  if (isStr(category, 1, 40)) { params.push(category); where.push(`l.category = $${params.length}`); }
  if (LISTING_TYPES.includes(type)) { params.push(type); where.push(`l.type = $${params.length}`); }
  if (isStr(q, 1, 100)) { params.push(`%${likeEscape(q)}%`); where.push(`l.name ilike $${params.length} escape '\\'`); }
  try {
    const r = await db.query(
      `select ${LIST_COLUMNS} from listings l join users u on u.id = l.seller_id
       where ${where.join(' and ')} order by l.created_at desc limit 100`,
      params
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// POST /api/listings
router.post('/', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const description = b.description === undefined ? '' : b.description;
  const price = b.priceCents === undefined ? 0 : b.priceCents;
  if (!isStr(name, 1, 120)) return res.status(400).json({ error: 'name is required (up to 120 characters)' });
  if (!isStr(b.category, 1, 40)) return res.status(400).json({ error: 'category is required (up to 40 characters)' });
  if (!LISTING_GRADES.includes(b.grade)) return res.status(400).json({ error: `grade must be one of ${LISTING_GRADES.join(', ')}` });
  if (!LISTING_TYPES.includes(b.type)) return res.status(400).json({ error: `type must be one of ${LISTING_TYPES.join(', ')}` });
  if (!isInt(price, 0, MAX_PRICE_CENTS)) return res.status(400).json({ error: 'priceCents must be a whole number of cents' });
  if (!isStr(description, 0, 2000)) return res.status(400).json({ error: 'description must be 2000 characters or fewer' });
  const minutes = b.auctionEndsInMinutes === undefined ? 60 : b.auctionEndsInMinutes;
  if (b.type === 'auction' && !isInt(minutes, 1, 10080)) return res.status(400).json({ error: 'auctionEndsInMinutes must be 1 to 10080 (one week)' });
  try {
    const auction = b.type === 'auction';
    const r = await db.query(
      `insert into listings (seller_id, name, description, category, grade, type, price_cents, current_bid_cents, ends_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9::int is null then null else now() + make_interval(mins => $9::int) end)
       returning *`,
      [req.user.id, name, description, b.category, b.grade, b.type, price, auction ? price : null, auction ? minutes : null]
    );
    const listing = r.rows[0];
    await award(req.user.id, 'listed');
    await recordActivity(req.user.id, 'listed', `Listed "${name}" on the marketplace`, listing.id);
    res.status(201).json({ ...listing, seller_handle: req.user.handle });
  } catch (err) { next(err); }
});

async function ownListing(req, res) {
  if (!isUuid(req.params.id)) { res.status(404).json({ error: 'Listing not found' }); return null; }
  const r = await db.query('select * from listings where id = $1', [req.params.id]);
  const listing = r.rows[0];
  if (!listing) { res.status(404).json({ error: 'Listing not found' }); return null; }
  if (listing.seller_id !== req.user.id) { res.status(403).json({ error: 'Only the seller can change this listing' }); return null; }
  return listing;
}

// PATCH /api/listings/:id   { status: active | sold | removed }   seller only
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const listing = await ownListing(req, res);
    if (!listing) return;
    const { status } = req.body || {};
    if (!['active', 'sold', 'removed'].includes(status)) return res.status(400).json({ error: 'status must be active, sold or removed' });
    const r = await db.query('update listings set status = $2 where id = $1 returning *', [listing.id, status]);
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/listings/:id   seller only. Kept as "removed" so offers and payments keep their history.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const listing = await ownListing(req, res);
    if (!listing) return;
    await db.query("update listings set status = 'removed' where id = $1", [listing.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/listings/:id/offers   { kind: buy | offer | trade, offerAmountCents?, tradeItemIds?, message? }
router.post('/:id/offers', requireAuth, writeLimiter, async (req, res, next) => {
  const b = req.body || {};
  const message = b.message === undefined ? '' : b.message;
  if (!['buy', 'offer', 'trade'].includes(b.kind)) return res.status(400).json({ error: 'kind must be buy, offer or trade' });
  if (b.kind === 'offer' && !isInt(b.offerAmountCents, 1, MAX_PRICE_CENTS)) return res.status(400).json({ error: 'offerAmountCents must be a whole number of cents' });
  if (b.kind === 'trade' && !(Array.isArray(b.tradeItemIds) && b.tradeItemIds.length >= 1 && b.tradeItemIds.length <= 10 && b.tradeItemIds.every(isUuid))) {
    return res.status(400).json({ error: 'tradeItemIds must list 1 to 10 of your collection items' });
  }
  if (!isStr(message, 0, 1000)) return res.status(400).json({ error: 'message must be 1000 characters or fewer' });
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
  try {
    const listing = (await db.query('select * from listings where id = $1', [req.params.id])).rows[0];
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.seller_id === req.user.id) return res.status(403).json({ error: 'You cannot make an offer on your own listing' });
    if (listing.status !== 'active') return res.status(409).json({ error: 'This listing is no longer available' });
    if (b.kind === 'buy' && listing.type !== 'sale') return res.status(400).json({ error: 'Only for-sale listings can be bought outright' });
    if (b.kind === 'trade') {
      const ids = [...new Set(b.tradeItemIds)];
      const owned = await db.query('select count(*)::int as n from collection_items where owner_id = $1 and id = any($2::uuid[])', [req.user.id, ids]);
      if (owned.rows[0].n !== ids.length) return res.status(400).json({ error: 'You can only offer marbles from your own collection' });
    }
    const amount = b.kind === 'buy' ? listing.price_cents : b.kind === 'offer' ? b.offerAmountCents : null;
    const r = await db.query(
      `insert into offers (listing_id, buyer_id, kind, offer_amount_cents, trade_item_ids, message)
       values ($1, $2, $3, $4, $5::uuid[], $6) returning *`,
      [listing.id, req.user.id, b.kind, amount, b.kind === 'trade' ? [...new Set(b.tradeItemIds)] : [], message]
    );
    const what = b.kind === 'buy' ? `wants to buy "${listing.name}" for ${money(amount)}`
      : b.kind === 'offer' ? `offered ${money(amount)} for "${listing.name}"`
      : `proposed a trade for "${listing.name}"`;
    await notify(listing.seller_id, 'offer_received', `${req.user.handle} ${what}`, r.rows[0].id);
    await award(req.user.id, 'traded');
    await recordActivity(req.user.id, 'offer', b.kind === 'trade' ? `Proposed a trade for "${listing.name}"` : `Sent an offer on "${listing.name}"`, listing.id);
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/listings/:id/bids   { amountCents }   row-locked so simultaneous bids can't both win
router.post('/:id/bids', requireAuth, writeLimiter, async (req, res, next) => {
  const { amountCents } = req.body || {};
  if (!isInt(amountCents, 1, MAX_PRICE_CENTS)) return res.status(400).json({ error: 'amountCents must be a whole number of cents' });
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Listing not found' });
  try {
    const out = await db.tx(async (client) => {
      const r = await client.query('select *, ends_at <= now() as ended from listings where id = $1 for update', [req.params.id]);
      const l = r.rows[0];
      if (!l) return { status: 404, body: { error: 'Listing not found' } };
      if (l.type !== 'auction') return { status: 400, body: { error: 'This listing is not an auction' } };
      if (l.seller_id === req.user.id) return { status: 403, body: { error: 'You cannot bid on your own auction' } };
      if (l.status !== 'active' || l.ended) return { status: 409, body: { error: 'This auction has ended' } };
      const min = l.current_bidder_id ? l.current_bid_cents + l.min_increment_cents : l.current_bid_cents;
      if (amountCents < min) return { status: 400, body: { error: `Your bid must be at least ${money(min)}`, minBidCents: min } };
      const bid = await client.query('insert into bids (listing_id, bidder_id, amount_cents) values ($1, $2, $3) returning id', [l.id, req.user.id, amountCents]);
      await client.query('update listings set current_bid_cents = $2, current_bidder_id = $3 where id = $1', [l.id, amountCents, req.user.id]);
      return { status: 201, body: { bidId: bid.rows[0].id, currentBidCents: amountCents }, outbid: l.current_bidder_id, listing: l };
    });
    if (out.outbid && out.outbid !== req.user.id) {
      await notify(out.outbid, 'outbid', `You were outbid on "${out.listing.name}": the bid is now ${money(amountCents)}`, out.listing.id);
    }
    res.status(out.status).json(out.body);
  } catch (err) { next(err); }
});

module.exports = router;
