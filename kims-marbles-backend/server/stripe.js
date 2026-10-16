// Stripe client and the ONE place the platform fee is computed (10%, always rounded down).
// Test mode only: a live key (sk_live_...) is refused unless STRIPE_ALLOW_LIVE=true, which
// should only be set after the legal review and Stripe's live-mode activation.
const Stripe = require('stripe');

const PLATFORM_FEE_PERCENT = 10;
const platformFeeCents = (amountCents) => Math.floor((amountCents * PLATFORM_FEE_PERCENT) / 100);

function assertTestModeKey(key) {
  if (typeof key === 'string' && key.startsWith('sk_live_') && process.env.STRIPE_ALLOW_LIVE !== 'true') {
    throw new Error('A live Stripe key is configured. Use a test key (sk_test_...) until live payments are approved.');
  }
}

let client = null;
function getStripe() {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  assertTestModeKey(key);
  client = new Stripe(key);
  return client;
}
const setStripeClient = (c) => { client = c; }; // tests

// Signature verification needs no API key, so it never depends on getStripe().
const constructEvent = (rawBody, signature, secret) => Stripe.webhooks.constructEvent(rawBody, signature, secret);

module.exports = { platformFeeCents, PLATFORM_FEE_PERCENT, assertTestModeKey, getStripe, setStripeClient, constructEvent };
