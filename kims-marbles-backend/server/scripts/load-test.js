// Load test: many simultaneous users on the real-time layer and the REST API at once.
//   node scripts/load-test.js --url http://127.0.0.1:4100 --rooms 4 --viewers 400 --chatters 40 --seconds 60 --http 30
// Run it against a server started with NODE_ENV=test (registration is rate limited otherwise),
// never against the live site. What it measures:
//   - chat fan-out: every chat message carries its send time; every viewer in the room records
//     how long it took to arrive, and whether it arrived at all
//   - REST: concurrent loops over the busiest public reads, requests/s and latency
//   - the server's own figures from /metrics (memory, sockets, event-loop health via latency)
const { io } = require('socket.io-client');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const URL_ = arg('url', 'http://127.0.0.1:4100');
const ROOMS = Number(arg('rooms', 4));
const VIEWERS = Number(arg('viewers', 400));
const CHATTERS = Number(arg('chatters', 40));
const SECONDS = Number(arg('seconds', 60));
const HTTP = Number(arg('http', 30));
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const ms = (x) => `${Number.isFinite(x) ? x.toFixed(1) : '-'} ms`;

async function api(method, p, body, token) {
  const r = await fetch(`${URL_}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const b = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new Error(`${method} ${p} ${r.status} ${JSON.stringify(b)}`);
  return b;
}
async function pool(n, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (i < n) { const k = i++; out[k] = await fn(k); } }));
  return out;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(URL_, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 20_000 });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
async function metrics() {
  if (!METRICS_TOKEN) return null;
  const t = await (await fetch(`${URL_}/metrics`, { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })).text();
  const v = (n) => Number((t.match(new RegExp(`^${n} (\\S+)$`, 'm')) || [])[1]);
  return { rssMB: v('process_resident_memory_bytes') / 1e6, sockets: v('km_socket_connections') };
}

(async () => {
  const tag = Date.now().toString(36);
  console.log(`load test → ${URL_}: ${ROOMS} rooms, ${VIEWERS} viewers, ${CHATTERS} chatters, ${HTTP} HTTP loops, ${SECONDS}s`);
  const before = await metrics();

  // hosts and chatters need accounts; viewers watch anonymously, like logged-out visitors
  const t0 = Date.now();
  const hosts = await pool(ROOMS, 8, async (i) => api('POST', '/api/auth/register', { handle: `lh${i}_${tag}`.slice(0, 24), email: `lh${i}_${tag}@load.test`, password: 'load-test-password' }));
  const chatters = await pool(CHATTERS, 8, async (i) => api('POST', '/api/auth/register', { handle: `lc${i}_${tag}`.slice(0, 24), email: `lc${i}_${tag}@load.test`, password: 'load-test-password' }));
  const rooms = await pool(ROOMS, 8, async (i) => api('POST', '/api/rooms', { title: `Load ${i}`, goLiveNow: true, maxGuests: 50 }, hosts[i].accessToken));
  console.log(`  accounts + rooms ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // everyone connects and joins a room; hosts stay in their rooms so they are not auto-ended
  const delivered = []; let received = 0;
  const join = async (s, roomId) => {
    const got = new Promise((r) => s.once('room:state', r));
    s.emit('room:join', { roomId });
    await got;
    s.on('room:chat', (m) => { const sent = Number((m.text.match(/t=(\d+)/) || [])[1]); if (sent) { delivered.push(Date.now() - sent); received += 1; } });
  };
  const t1 = Date.now();
  const hostSockets = await pool(ROOMS, 8, async (i) => { const s = await connect(hosts[i].accessToken); await join(s, rooms[i].id); return s; });
  const viewerSockets = await pool(VIEWERS, 50, async (i) => { const s = await connect(); await join(s, rooms[i % ROOMS].id); return s; });
  const chatSockets = await pool(CHATTERS, 20, async (i) => { const s = await connect(chatters[i].accessToken); await join(s, rooms[i % ROOMS].id); return { s, room: rooms[i % ROOMS].id }; });
  const joinSecs = (Date.now() - t1) / 1000;
  console.log(`  ${VIEWERS + CHATTERS + ROOMS} sockets connected and in rooms in ${joinSecs.toFixed(1)}s`);
  const perRoom = Array.from({ length: ROOMS }, (_, r) => 1 /* host */ + viewerSockets.filter((_, i) => i % ROOMS === r).length + chatSockets.filter((_, i) => i % ROOMS === r).length);

  // HTTP load alongside
  const httpLat = []; let httpErrors = 0; let stop = false;
  const paths = ['/api/listings', '/api/rooms', '/api/feed', '/api/battles/leaderboard', '/health'];
  const loops = Array.from({ length: HTTP }, async (_, k) => {
    let n = k;
    while (!stop) {
      const s = performance.now();
      try { const r = await fetch(`${URL_}${paths[n++ % paths.length]}`); await r.arrayBuffer(); if (r.status >= 400) httpErrors += 1; } catch (_e) { httpErrors += 1; }
      httpLat.push(performance.now() - s);
    }
  });

  // chat: each chatter sends one message every ~1.2 s (just under the per-user chat limit)
  let sent = 0; const expected = { n: 0 };
  const chatLoops = chatSockets.map(async ({ s, room }, i) => {
    await sleep((i * 1200) / CHATTERS);
    const roomIdx = rooms.findIndex((r) => r.id === room);
    while (!stop) {
      s.emit('room:chat', { roomId: room, text: `hello t=${Date.now()}` });
      sent += 1; expected.n += perRoom[roomIdx];
      await sleep(1200);
    }
  });
  await sleep(SECONDS * 1000);
  stop = true;
  await Promise.all([...loops, ...chatLoops]);
  await sleep(2000); // let in-flight messages land
  const during = await metrics();

  for (const s of [...hostSockets, ...viewerSockets, ...chatSockets.map((c) => c.s)]) s.disconnect();

  const lost = expected.n - received;
  console.log('\nresults');
  console.log(`  chat: ${sent} messages sent, ${received} deliveries of ${expected.n} expected (${((received / expected.n) * 100).toFixed(2)}%), ${lost} missing`);
  console.log(`  chat delivery latency: p50 ${ms(pct(delivered, 50))}, p95 ${ms(pct(delivered, 95))}, p99 ${ms(pct(delivered, 99))}, max ${ms(Math.max(...delivered))}`);
  console.log(`  chat fan-out rate: ${(received / SECONDS).toFixed(0)} deliveries/s`);
  console.log(`  HTTP: ${httpLat.length} requests, ${(httpLat.length / SECONDS).toFixed(0)} req/s, errors ${httpErrors}, p50 ${ms(pct(httpLat, 50))}, p95 ${ms(pct(httpLat, 95))}, p99 ${ms(pct(httpLat, 99))}`);
  if (before && during) console.log(`  server memory: ${before.rssMB.toFixed(0)} MB idle → ${during.rssMB.toFixed(0)} MB under load; sockets seen by server: ${during.sockets}`);
  process.exit(lost > expected.n * 0.001 || httpErrors ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
