// The Express app on its own: routes and middleware, no listen(), no Socket.io, no mediasoup.
// The test suite imports this; index.js boots it into the real server.
const express = require('express');
const cors = require('cors');
const ops = require('./ops');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind nginx: rate limits key on the real client IP
app.use(ops.securityHeaders);
app.use(ops.countRequests);

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : process.env.NODE_ENV !== 'production' }));
// Stripe needs the exact raw bytes to verify a webhook's signature: mount it before express.json.
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), require('./routes/payments').webhook);
app.use(express.json({ limit: '100kb' }));

app.get('/health', ops.health);
app.get('/metrics', ops.metrics);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/offers', require('./routes/offers'));
app.use('/api/collection', require('./routes/collection'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/battles', require('./routes/battles'));
app.use('/api/feed', require('./routes/feed'));
app.use('/api/conversations', require('./routes/messages'));
app.use('/api/users', require('./routes/users'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/games', require('./routes/games'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/moderation', require('./routes/moderation'));
app.use('/api/rtc', require('./routes/rtc'));
app.use('/api/payments', require('./routes/payments'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large' });
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

module.exports = app;
