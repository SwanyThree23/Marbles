// Stripe Connect (Express accounts): sellers and hosts onboard, buyers pay accepted offers,
// viewers tip live hosts. The platform keeps platformFeeCents(); Stripe sends the rest to
// the payee's connected account. The webhook is the only thing that marks money as paid.
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimit');
const { isUuid, isInt, isStr } = require('../validate');
const { getStripe, platformFeeCents, constructEvent } = require('../stripe');
const { notify } = require('../notify');
const { award } = require('../achievements');

const router = express.Router();
const money = (c) => `$${(c / 100).toFixed(2)}`;
const appUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');

function stripeOr503(res) {
  const s = getStripe();
  if (!s) res.status(503).json({ error: 'Payments are not configured on this server yet' });
  return s;
}

router.post('/onboard', requireAuth, async (req, res, next) => {
  const stripe = stripeOr503(res);
  if (!stripe) return;
  try {
    let acct = (await db.query('select stripe_account_id from users where id = $1', [req.user.id])).rows[0].stripe_account_id;
    if (!acct) {
      acct = (await stripe.accounts.create({ type: 'express', metadata: { userId: req.user.id } })).id;
      await db.query('update users set stripe_account_id = $2 where id = $1', [req.user.id, acct]);
    }
    const link = await stripe.accountLinks.create({
      account: acct, type: 'account_onboarding',
      refresh_url: `${appUrl()}/me?payouts=retry`, return_url: `${appUrl()}/me?payouts=done`,
    });
    res.json({ url: link.url });
  } catch (err) { next(err); }
});

router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const acct = (await db.query('select stripe_account_id from users where id = $1', [req.user.id])).rows[0].stripe_account_id;
    if (!acct) return res.json({ onboarded: false, chargesEnabled: false });
    const stripe = stripeOr503(res);
    if (!stripe) return;
    const a = await stripe.accounts.retrieve(acct);
    res.json({ onboarded: true, chargesEnabled: !!a.charges_enabled });
  } catch (err) { next(err); }
});

async function createSession(stripe, { name, amountCents, destination, successUrl, cancelUrl, metadata }) {
  return stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name } } }],
    payment_intent_data: { application_fee_amount: platformFeeCents(amountCents), transfer_data: { destination } },
    success_url: successUrl, cancel_url: cancelUrl, metadata,
  });
}

// POST /api/payments/checkout   { offerId } — the buyer pays an ACCEPTED offer
router.post('/checkout', requireAuth, writeLimiter, async (req, res, next) => {
  const { offerId } = req.body || {};
  if (!isUuid(offerId)) return res.status(404).json({ error: 'Offer not found' });
  try {
    const o = (await db.query(
      `select o.*, l.name, l.seller_id, s.stripe_account_id from offers o join listings l on l.id = o.listing_id
       join users s on s.id = l.seller_id where o.id = $1`, [offerId]
    )).rows[0];
    if (!o) return res.status(404).json({ error: 'Offer not found' });
    if (o.buyer_id !== req.user.id) return res.status(403).json({ error: 'Only the buyer can pay for this offer' });
    if (o.status !== 'accepted') return res.status(409).json({ error: 'The seller has not accepted this offer yet' });
    if (!o.offer_amount_cents) return res.status(400).json({ error: 'Trades are settled between collectors, not paid here' });
    if (!o.stripe_account_id) return res.status(400).json({ error: 'This seller has not set up payouts yet' });
    const stripe = stripeOr503(res);
    if (!stripe) return;
    const session = await createSession(stripe, {
      name: o.name, amountCents: o.offer_amount_cents, destination: o.stripe_account_id,
      successUrl: `${appUrl()}/market?paid=${o.id}`, cancelUrl: `${appUrl()}/market?cancelled=${o.id}`,
      metadata: { kind: 'order', offerId: o.id },
    });
    await db.query(
      `insert into payments (kind, payer_id, payee_id, offer_id, amount_cents, platform_fee_cents, stripe_session_id)
       values ('order', $1, $2, $3, $4, $5, $6)`,
      [req.user.id, o.seller_id, o.id, o.offer_amount_cents, platformFeeCents(o.offer_amount_cents), session.id]
    );
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// POST /api/payments/tip   { roomId, amountCents (100..100000), message? }
router.post('/tip', requireAuth, writeLimiter, async (req, res, next) => {
  const { roomId, amountCents } = req.body || {};
  const message = req.body?.message === undefined ? '' : req.body.message;
  if (!isUuid(roomId)) return res.status(400).json({ error: 'roomId must be a room id' });
  if (!isInt(amountCents, 100, 100000)) return res.status(400).json({ error: 'Tips are $1 to $1,000' });
  if (!isStr(message, 0, 280)) return res.status(400).json({ error: 'Messages are up to 280 characters' });
  try {
    const room = (await db.query(
      'select r.*, u.handle as host_handle, u.stripe_account_id from rooms r join users u on u.id = r.host_id where r.id = $1', [roomId]
    )).rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.host_id === req.user.id) return res.status(400).json({ error: 'You cannot tip yourself' });
    if (room.status !== 'live') return res.status(409).json({ error: 'This stream is not live' });
    if (!room.stripe_account_id) return res.status(400).json({ error: 'This host has not set up payouts yet' });
    const stripe = stripeOr503(res);
    if (!stripe) return;
    const session = await createSession(stripe, {
      name: `Tip for ${room.host_handle}`, amountCents, destination: room.stripe_account_id,
      successUrl: `${appUrl()}/live/${room.id}?tip=success`, cancelUrl: `${appUrl()}/live/${room.id}?tip=cancelled`,
      metadata: { kind: 'tip', roomId: room.id },
    });
    await db.query(
      `insert into payments (kind, payer_id, payee_id, room_id, amount_cents, platform_fee_cents, message, stripe_session_id)
       values ('tip', $1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, room.host_id, room.id, amountCents, platformFeeCents(amountCents), message.trim(), session.id]
    );
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// POST /api/payments/webhook — raw body (mounted before express.json in app.js), Stripe-signed.
// Idempotent twice over: each event id is processed once, and a payment only moves out of
// "pending" once, so a re-sent event or a second event for the same session changes nothing.
async function webhook(req, res, next) {
  let event;
  try {
    event = constructEvent(req.body, req.get('stripe-signature') || '', process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (_err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const after = await db.tx(async (client) => {
      const fresh = await client.query('insert into processed_webhook_events (event_id) values ($1) on conflict do nothing', [event.id]);
      if (!fresh.rowCount) return null;
      const s = event.data?.object || {};
      if (event.type === 'checkout.session.expired') {
        await client.query("update payments set status = 'expired' where stripe_session_id = $1 and status = 'pending'", [s.id]);
        return null;
      }
      if (event.type !== 'checkout.session.completed' || s.payment_status === 'unpaid') return null;
      const r = await client.query(
        "update payments set status = 'paid', paid_at = now() where stripe_session_id = $1 and status = 'pending' returning *", [s.id]
      );
      const p = r.rows[0];
      if (!p) return null;
      if (p.kind === 'order') {
        const o = (await client.query("update offers set status = 'paid' where id = $1 returning listing_id", [p.offer_id])).rows[0];
        if (o) await client.query("update listings set status = 'sold' where id = $1", [o.listing_id]);
      }
      const payer = (await client.query('select handle from users where id = $1', [p.payer_id])).rows[0]?.handle || 'Someone';
      return p.kind === 'tip'
        ? { user: p.payee_id, text: `${payer} tipped you ${money(p.amount_cents)}${p.message ? `: "${p.message}"` : ''}`, ref: p.room_id }
        : { user: p.payee_id, text: `${payer} paid ${money(p.amount_cents)} for your marble`, ref: p.offer_id, award: [p.payee_id, p.payer_id] };
    });
    if (after) {
      await notify(after.user, 'payment_received', after.text, after.ref);
      for (const u of after.award || []) if (u) await award(u, 'traded');
    }
    res.json({ received: true });
  } catch (err) { next(err); }
}

module.exports = router;
module.exports.webhook = webhook;
