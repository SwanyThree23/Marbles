// Boots the real server: HTTP (app.js) + Socket.io + the mediasoup worker pool + listen().
// This is what `npm start` and PM2 run. Shuts down cleanly on SIGTERM/SIGINT.
const http = require('http');
const { Server } = require('socket.io');

const { checkConfig } = require('./config');

{
  const { errors, warnings } = checkConfig(process.env);
  for (const w of warnings) console.warn(`[config] warning: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`[config] ${e}`);
    console.error(`[config] refusing to start: fix the ${errors.length} problem(s) above in the server's .env`);
    process.exit(1);
  }
}

const app = require('./app');
const db = require('./db');
const realtime = require('./realtime');
const { setEmitter } = require('./notify');
const auth = require('./routes/auth');
const sockets = require('./sockets');
const workers = require('./mediasoup/worker');
const signaling = require('./mediasoup/signaling');

const PORT = parseInt(process.env.PORT || '4100', 10);
const MS_PORT = parseInt(process.env.MEDIASOUP_PORT || '44444', 10);
const MS_WORKERS = parseInt(process.env.MEDIASOUP_WORKERS || '2', 10);

async function main() {
  const server = http.createServer(app);
  const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const io = new Server(server, {
    cors: { origin: origins.length ? origins : process.env.NODE_ENV !== 'production' },
    maxHttpBufferSize: 256 * 1024,
  });

  realtime.setIo(io);
  setEmitter((userId, event, payload) => realtime.toUser(userId, event, payload));
  auth.setOnLogoutAll((userId) => realtime.disconnectUser(userId));
  realtime.onRoomEnded((roomId) => {
    require('./socketGuard').forgetRoom(roomId);
    require('./roomState').forget(roomId);
    require('./mediasoup/rooms').closeRoom(roomId);
    require('./hostPresence').forget(roomId);
  });

  try {
    await workers.startWorkers({ count: MS_WORKERS, basePort: MS_PORT, announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP });
  } catch (err) {
    console.error(`[mediasoup] could not start on port ${MS_PORT}+ (${err.message}). Is another server using it?`);
    process.exit(1);
  }
  console.log(`[mediasoup] ${MS_WORKERS} worker(s) ready — WebRTC on ports ${MS_PORT}-${MS_PORT + MS_WORKERS - 1} (udp+tcp), announced as ${process.env.MEDIASOUP_ANNOUNCED_IP || '(local address)'}`);

  sockets.register(io);
  require('./ops').setProviders({
    sfu: () => ({ ...workers.stats(), ...signaling.stats() }),
    sockets: () => io.engine.clientsCount,
    presence: () => require('./hostPresence').stats(),
  });
  require('./hostPresence').start({ graceMs: parseInt(process.env.HOST_GRACE_MS || '120000', 10) });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    // close the connections without a "disconnect" packet: socket.io clients treat that packet
    // as "you were kicked" and never reconnect, so a deploy would strand every viewer
    await new Promise((r) => io.close(() => r()));
    await workers.closeWorkers();
    await db.pool.end().catch(() => {});
    process.exit(0);
  }
  // mediasoup's Worker installs its own signal handlers, which disables Node's default
  // exit-on-signal: without these the process would hang until force-killed.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
}

main().catch((err) => { console.error('[server] failed to start', err); process.exit(1); });
