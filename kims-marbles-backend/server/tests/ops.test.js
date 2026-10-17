// What the operator relies on: security headers, /health that really checks the database
// and the media workers, and /metrics that is useful but never public.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, resetDb } = require('./setup');
const { startServer, stopServer, connect, closeSockets, register, rest } = require('./live-server');

let server;
before(async () => { await resetDb(); server = await startServer({ METRICS_TOKEN: 'metrics-test-token-0123456789abcdef' }); });
after(async () => { closeSockets(); await stopServer(server); await db.pool.end(); });

test('every API response carries the security headers; the server does not announce itself', async () => {
  for (const p of ['/health', '/api/listings', '/api/nope']) {
    const r = await fetch(`${server.url}${p}`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/, p);
    assert.equal(r.headers.get('x-powered-by'), null, p);
  }
});

test('/health reports the database and the media workers', async () => {
  const r = await fetch(`${server.url}/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, 'up');
  assert.equal(body.sfu.workers, 1);
  assert.equal(typeof body.uptimeSeconds, 'number');
});

test('/health is 503 when the database is unreachable', async () => {
  const bad = await startServer({ DATABASE_URL: 'postgres://postgres@127.0.0.1:1/nowhere' });
  try {
    const r = await fetch(`${bad.url}/health`);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.equal(body.db, 'down');
  } finally { await stopServer(bad); }
});

test('/metrics needs the token, and never answers a request that came through the proxy without it', async () => {
  assert.equal((await fetch(`${server.url}/metrics`)).status, 404);
  assert.equal((await fetch(`${server.url}/metrics`, { headers: { Authorization: 'Bearer wrong' } })).status, 404);
  assert.equal((await fetch(`${server.url}/metrics`, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 404);
  const ok = await fetch(`${server.url}/metrics`, { headers: { Authorization: 'Bearer metrics-test-token-0123456789abcdef' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/plain/);
});

test('/metrics counts real activity: requests by status, live sockets, SFU rooms, the DB pool', async () => {
  const u = await register(server, 'Metric');
  const room = (await rest(server, u, 'POST', '/api/rooms', { title: 'M', goLiveNow: true })).body;
  const s = await connect(server, u.token);
  await new Promise((resolve) => s.emit('ms:join', { roomId: room.id }, resolve));
  await fetch(`${server.url}/api/nope`);
  const text = await (await fetch(`${server.url}/metrics`, { headers: { Authorization: 'Bearer metrics-test-token-0123456789abcdef' } })).text();
  const val = (name) => { const m = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm')); return m ? Number(m[1]) : null; };
  assert.ok(val('km_socket_connections') >= 1, 'sockets');
  assert.equal(val('km_sfu_rooms'), 1);
  assert.equal(val('km_sfu_peers'), 1);
  assert.equal(val('km_sfu_workers'), 1);
  assert.ok(val('km_db_pool_total') >= 1, 'db pool');
  assert.match(text, /^km_http_requests_total\{status="4xx"\} [1-9]\d*$/m);
  assert.match(text, /^km_http_requests_total\{status="2xx"\} [1-9]\d*$/m);
  assert.ok(val('process_resident_memory_bytes') > 1e6);
  assert.ok(val('km_rooms_live') >= 1);
  assert.match(text, /# TYPE km_http_requests_total counter/);
});
