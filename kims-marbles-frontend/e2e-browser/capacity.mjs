// Media capacity probe (not a pass/fail test): 2 people on stage, a growing number of
// watch-only viewers, each receiving both people's video and audio through the SFU.
// Measures the mediasoup worker's CPU per forwarded stream and the bitrate one viewer gets.
//   METRICS_TOKEN=... node e2e-browser/capacity.mjs 4 8 16 24
// Needs the backend (MEDIASOUP_WORKERS=1) and the built app as for the browser suite.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { API, APP, startBrowser, stopBrowser, sleep, until, newUser, openPage, waitLive, playing, cleanup } from './helpers.mjs';

const steps = process.argv.slice(2).map(Number).filter(Boolean);
const TOKEN = process.env.METRICS_TOKEN;
const workerPid = () => Number(execSync('pgrep -f mediasoup-worker | head -1').toString().trim());
const ticks = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
const HZ = Number(execSync('getconf CLK_TCK').toString());
async function workerCpu(pid, seconds = 10) {
  const a = ticks(pid); await sleep(seconds * 1000); const b = ticks(pid);
  return ((b - a) / HZ / seconds) * 100; // % of one core
}
async function metric(name) {
  const t = await (await fetch(`${API}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } })).text();
  return Number((t.match(new RegExp(`^${name} (\\S+)$`, 'm')) || [])[1]);
}
async function inboundKbps(page) {
  const bytes = () => page.evaluate(async () => {
    let n = 0;
    for (const pc of window.__pcs || []) (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp') n += s.bytesReceived; });
    return n;
  });
  const a = await bytes(); await sleep(3000); const b = await bytes();
  return ((b - a) * 8) / 3 / 1000;
}

await startBrowser();
try {
  const host = await newUser('cap'); const guest = await newUser('capg');
  const room = await (await fetch(`${API}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.accessToken}` }, body: JSON.stringify({ title: 'Capacity', goLiveNow: true, maxGuests: 1 }) })).json();
  const hp = await openPage(host); await hp.goto(`${APP}/live/${room.id}`); await waitLive(hp);
  const gp = await openPage(guest); await gp.goto(`${APP}/live/${room.id}`); await waitLive(gp);
  await until(() => playing(hp, guest.handle), { timeout: 30_000, what: 'stage up' });
  const pid = workerPid();
  const idle = await workerCpu(pid, 8);
  console.log(`stage: 2 publishers; worker idle-ish CPU with 2 people: ${idle.toFixed(1)}% of a core`);
  const viewers = [];
  for (const n of steps) {
    while (viewers.length < n) {
      const v = await newUser('v'); const p = await openPage(v);
      await p.setViewportSize({ width: 320, height: 240 });
      await p.goto(`${APP}/live/${room.id}`);
      await p.getByText(/stage is full/).waitFor({ timeout: 20_000 });
      viewers.push(p);
    }
    const last = viewers.at(-1);
    await until(async () => (await playing(last, host.handle)) && (await playing(last, guest.handle)), { timeout: 40_000, what: `viewer ${n} watching` });
    await sleep(4000);
    const cpu = await workerCpu(pid, 10);
    const consumers = await metric('km_sfu_consumers');
    const kbps = await inboundKbps(last);
    const perStream = (cpu - idle) / Math.max(1, consumers);
    console.log(`viewers ${String(n).padStart(3)} | consumers ${String(consumers).padStart(4)} | worker ${cpu.toFixed(1).padStart(5)}% of a core | ${perStream.toFixed(3)}% per stream | one viewer receives ${kbps.toFixed(0)} kbit/s`);
  }
} finally { await cleanup(); await stopBrowser(); }
