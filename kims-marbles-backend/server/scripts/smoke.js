// Post-deploy smoke test against a running site. Exits non-zero on the first broken check.
//   node scripts/smoke.js https://vibenbones.online
//   node scripts/smoke.js http://localhost:8080 --allow-http      (local)
// It registers one throwaway user (smoke_<time>) to test login and the real-time socket.
const { io } = require('socket.io-client');

const base = (process.argv[2] || '').replace(/\/$/, '');
const allowHttp = process.argv.includes('--allow-http');
if (!/^https?:\/\//.test(base)) { console.error('usage: node scripts/smoke.js https://your.domain [--allow-http]'); process.exit(2); }

let failed = 0;
async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  ok   ${name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name} — ${err.message}`);
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const get = (p, opts) => fetch(`${base}${p}`, { redirect: 'manual', ...opts });

(async () => {
  console.log(`smoke test: ${base}`);
  let session = null;

  if (!allowHttp) {
    await check('http redirects to https', async () => {
      const r = await fetch(base.replace(/^https:/, 'http:'), { redirect: 'manual' });
      must([301, 308].includes(r.status) && (r.headers.get('location') || '').startsWith('https://'), `got ${r.status} ${r.headers.get('location')}`);
    });
    await check('HSTS is on', async () => {
      must(/max-age=\d+/.test((await get('/')).headers.get('strict-transport-security') || ''), 'no Strict-Transport-Security header');
    });
  }

  await check('/health: database and media workers up', async () => {
    const r = await get('/health');
    const b = await r.json();
    must(r.status === 200 && b.ok && b.db === 'up', JSON.stringify(b));
    must(b.sfu && b.sfu.workers >= 1, `no media workers: ${JSON.stringify(b.sfu)}`);
    return `${b.sfu.workers} media worker(s), up ${b.uptimeSeconds}s`;
  });

  await check('the app loads with a strict Content-Security-Policy', async () => {
    const r = await get('/');
    const html = await r.text();
    must(r.status === 200 && html.includes('<div id="root">'), `status ${r.status}`);
    const csp = r.headers.get('content-security-policy') || '';
    must(/script-src 'self' 'sha256-/.test(csp) && /frame-ancestors 'none'/.test(csp), `CSP: ${csp || '(none)'}`);
    const js = html.match(/\/assets\/index-[\w-]+\.js/);
    must(js, 'no app bundle referenced');
    const code = await (await get(js[0])).text();
    must(!code.includes('localhost:4100'), 'the bundle calls localhost:4100: rebuild with VITE_API_URL= (empty)');
  });

  await check('deep links load the app (/live/..., /join/...)', async () => {
    for (const p of ['/live/00000000-0000-0000-0000-000000000000', '/join/abc', '/market']) {
      const r = await get(p);
      must(r.status === 200 && (await r.text()).includes('<div id="root">'), `${p}: ${r.status}`);
    }
  });

  await check('/metrics is not public', async () => {
    const r = await get('/metrics');
    must(r.status === 404, `got ${r.status}`);
  });

  await check('register and log in', async () => {
    const handle = `smoke_${Date.now().toString(36)}`.slice(0, 24);
    const password = `Smoke-${Math.random().toString(36).slice(2)}-test`;
    const reg = await get('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle, email: `${handle}@smoke.invalid`, password }) });
    must(reg.status === 201, `register ${reg.status} ${await reg.text()}`);
    const login = await get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${handle}@smoke.invalid`, password }) });
    must(login.status === 200, `login ${login.status}`);
    session = await login.json();
    return handle;
  });

  await check('an authenticated API call works', async () => {
    must(session, 'no session');
    const r = await get('/api/dashboard', { headers: { Authorization: `Bearer ${session.accessToken}` } });
    must(r.status === 200, `dashboard ${r.status}`);
  });

  await check('TURN credentials are issued', async () => {
    must(session, 'no session');
    const r = await get('/api/rtc/ice-servers', { headers: { Authorization: `Bearer ${session.accessToken}` } });
    const b = await r.json();
    const turn = (b.iceServers || []).find((s) => s.username);
    must(turn, `no TURN entry: ${JSON.stringify(b)}`);
    return turn.urls.join(' ');
  });

  await check('real-time socket connects over WebSocket through the proxy', async () => {
    must(session, 'no session');
    await new Promise((resolve, reject) => {
      const s = io(base, { auth: { token: session.accessToken }, transports: ['websocket'], reconnection: false, timeout: 10_000, rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' });
      const t = setTimeout(() => { s.close(); reject(new Error('timed out')); }, 12_000);
      s.on('connect', () => {
        // a device list comes back over the socket: proves the server knows who we are
        s.emit('device:register', { deviceId: 'smoke-test', label: 'smoke test' });
      });
      s.on('device:list', (list) => {
        clearTimeout(t); s.close();
        if (list.some((d) => d.deviceId === 'smoke-test')) resolve(); else reject(new Error('device not registered'));
      });
      s.on('connect_error', (e) => { clearTimeout(t); reject(new Error(e.message)); });
    });
  });

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
