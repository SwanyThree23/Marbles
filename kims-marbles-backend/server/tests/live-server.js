// Spawns the REAL server (node index.js) as a child process against the test database and
// gives tests real Socket.io clients. Nothing is mocked.
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const children = new Set();

async function startServer(extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const msPort = 40000 + Math.floor(Math.random() * 9000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), MEDIASOUP_PORT: String(msPort), MEDIASOUP_WORKERS: '1',
      MEDIASOUP_ANNOUNCED_IP: '127.0.0.1', LOG_LEVEL: 'warn', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.output = () => out;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20_000);
    const check = () => { if (out.includes(`listening on :${port}`)) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exited (${code}) during startup:\n${out}`)); });
  });
  child.removeAllListeners('exit');
  child.url = `http://127.0.0.1:${port}`;
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 8000);
  await done;
  clearTimeout(t);
  children.delete(child);
}

const sockets = new Set();
function connect(server, token, opts = {}) {
  const s = io(server.url, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true, reconnection: false, ...opts });
  sockets.add(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
function closeSockets() { for (const s of sockets) s.disconnect(); sockets.clear(); }

// resolves with the next `event` payload (optionally matching `pred`), rejects after `ms`
function waitFor(socket, event, { ms = 3000, pred = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`timed out waiting for ${event}`)); }, ms);
    function h(data) { if (pred(data)) { clearTimeout(t); socket.off(event, h); resolve(data); } }
    socket.on(event, h);
  });
}
// true if `event` arrives within `ms` (use to prove something did NOT arrive)
function arrives(socket, event, ms = 600, pred = () => true) {
  return waitFor(socket, event, { ms, pred }).then(() => true, () => false);
}
function ack(socket, event, payload, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), ms);
    socket.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}

async function register(server, handle) {
  const r = await fetch(`${server.url}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, email: `${handle.toLowerCase()}@x.com`, password: 'password123' }),
  });
  const b = await r.json();
  if (r.status !== 201) throw new Error(`register ${handle}: ${r.status} ${JSON.stringify(b)}`);
  return { token: b.accessToken, refreshToken: b.refreshToken, id: b.user.id, handle };
}
async function rest(server, user, method, p, body) {
  const r = await fetch(`${server.url}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

process.on('exit', () => { for (const c of children) c.kill('SIGKILL'); });

module.exports = { startServer, stopServer, connect, closeSockets, waitFor, arrives, ack, register, rest };
