// The mediasoup worker pool. Worker i owns ONE WebRtcServer listening on MEDIASOUP_PORT + i
// for both UDP and TCP, so the firewall needs a handful of ports, not a range.
const mediasoup = require('mediasoup');

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
];

let pool = [];
let next = 0;

async function startWorkers({ count, basePort, announcedIp, listenIp = '0.0.0.0' }) {
  for (let i = 0; i < count; i++) {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    worker.on('died', () => {
      console.error(`[mediasoup] worker ${worker.pid} died; exiting so the process manager restarts us`);
      process.exit(1);
    });
    const port = basePort + i;
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ip: listenIp, announcedAddress: announcedIp || undefined, port },
        { protocol: 'tcp', ip: listenIp, announcedAddress: announcedIp || undefined, port },
      ],
    });
    pool.push({ worker, webRtcServer, port });
  }
  return pool;
}

function nextWorker() {
  if (!pool.length) throw new Error('mediasoup workers are not running');
  const w = pool[next % pool.length];
  next += 1;
  return w;
}

async function closeWorkers() {
  for (const { worker } of pool) worker.close();
  pool = [];
}

const stats = () => ({ workers: pool.length, ports: pool.map((p) => p.port) });

module.exports = { MEDIA_CODECS, startWorkers, nextWorker, closeWorkers, stats };
