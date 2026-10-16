// Per-IP request limits for brute-force- and spam-prone routes. In-process memory: fine for
// the single-instance deployment (see DEPLOY.md). Off in NODE_ENV=test so suites can run fast.
const { rateLimit } = require('express-rate-limit');

const make = (windowMs, limit, error) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error },
});

const authLimiter = make(15 * 60_000, 10, 'Too many attempts. Wait a few minutes and try again.');
const writeLimiter = make(60_000, 30, 'You are doing that too fast. Wait a minute and try again.');

module.exports = { authLimiter, writeLimiter };
