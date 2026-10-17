// Operations: security headers, /health and /metrics (Prometheus text format).
// index.js registers the live parts (sockets, SFU, rooms) with setProviders(); the Express
// app alone (the REST test suite) reports only HTTP, process and database figures.
const crypto = require('crypto');
const db = require('./db');

const started = Date.now();
let providers = { sfu: null, sockets: null, presence: null };
const setProviders = (p) => { providers = { ...providers, ...p }; };

// ---- headers: this server only ever returns JSON, so nothing may be framed, sniffed or run ----
function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ---- request counting (and a one-line log in production) ----
const counts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
let durationSum = 0;
let durationCount = 0;
function countRequests(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const secs = Number(process.hrtime.bigint() - t0) / 1e9;
    const cls = `${Math.floor(res.statusCode / 100)}xx`;
    if (cls in counts) counts[cls] += 1;
    durationSum += secs; durationCount += 1;
    if (process.env.NODE_ENV === 'production' && req.path !== '/health' && process.env.LOG_LEVEL !== 'warn') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${(secs * 1000).toFixed(0)}ms`);
    }
  });
  next();
}

async function health(_req, res) {
  const body = { ok: true, service: 'kims-marbles-server', uptimeSeconds: Math.round((Date.now() - started) / 1000) };
  try {
    await db.query('select 1');
    body.db = 'up';
  } catch (_err) {
    body.db = 'down';
    body.ok = false;
  }
  if (providers.sfu) {
    const s = providers.sfu();
    body.sfu = { workers: s.workers };
    if (!s.workers) body.ok = false;
  }
  res.status(body.ok ? 200 : 503).json(body);
}

// /metrics: Bearer METRICS_TOKEN only. Without a token configured it is off. A request that
// came through nginx (X-Forwarded-For) is refused without the token, so it is never public.
function metricsAllowed(req) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return false;
  const given = (req.get('authorization') || '').replace(/^Bearer /, '');
  const a = Buffer.from(given); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function metrics(req, res) {
  if (!metricsAllowed(req)) return res.status(404).json({ error: 'Not found' });
  const lines = [];
  const metric = (name, type, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) lines.push(`${name}${labels} ${v}`);
  };
  const one = (name, type, help, v) => metric(name, type, help, [['', v]]);
  const mem = process.memoryUsage();
  one('process_resident_memory_bytes', 'gauge', 'Resident memory.', mem.rss);
  one('process_heap_used_bytes', 'gauge', 'V8 heap in use.', mem.heapUsed);
  one('process_uptime_seconds', 'gauge', 'Seconds since start.', Math.round((Date.now() - started) / 1000));
  metric('km_http_requests_total', 'counter', 'HTTP responses by status class.', Object.entries(counts).map(([k, v]) => [`{status="${k}"}`, v]));
  one('km_http_request_duration_seconds_sum', 'counter', 'Total time spent answering HTTP requests.', durationSum.toFixed(3));
  one('km_http_request_duration_seconds_count', 'counter', 'HTTP requests timed.', durationCount);
  one('km_db_pool_total', 'gauge', 'Database connections open.', db.pool.totalCount);
  one('km_db_pool_idle', 'gauge', 'Database connections idle.', db.pool.idleCount);
  one('km_db_pool_waiting', 'gauge', 'Queries waiting for a connection.', db.pool.waitingCount);
  try {
    const r = await db.query("select count(*)::int as n from rooms where status = 'live'");
    one('km_rooms_live', 'gauge', 'Rooms marked live in the database.', r.rows[0].n);
  } catch (_e) { /* database down: /health says so */ }
  if (providers.sockets) one('km_socket_connections', 'gauge', 'Connected Socket.io clients.', providers.sockets());
  if (providers.sfu) {
    const s = providers.sfu();
    one('km_sfu_workers', 'gauge', 'mediasoup workers running.', s.workers);
    for (const k of ['rooms', 'peers', 'producers', 'consumers', 'publisherLeases']) {
      if (typeof s[k] === 'number') one(`km_sfu_${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`, 'gauge', `SFU ${k}.`, s[k]);
    }
  }
  if (providers.presence) {
    const p = providers.presence();
    one('km_rooms_host_present', 'gauge', 'Live rooms whose host is connected.', p.roomsWithHostPresent);
    one('km_rooms_host_absent', 'gauge', 'Live rooms counting down to auto-end.', p.roomsWithHostAbsent);
  }
  res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
}

module.exports = { securityHeaders, countRequests, health, metrics, setProviders };
