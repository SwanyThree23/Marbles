// The Express app on its own: routes and middleware, no listen(), no Socket.io, no mediasoup.
// The test suite imports this; index.js boots it into the real server.
const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind nginx: rate limits key on the real client IP

const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : process.env.NODE_ENV !== 'production' }));
app.use(express.json({ limit: '100kb' }));

app.get('/health', async (_req, res) => {
  try {
    await db.query('select 1');
    res.json({ ok: true, service: 'kims-marbles-server' });
  } catch (_err) {
    res.status(503).json({ ok: false, service: 'kims-marbles-server', error: 'database unreachable' });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/listings', require('./routes/listings'));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request body is too large' });
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(500).json({ error: 'Something went wrong on our side' });
});

module.exports = app;
