// Shared helpers for the real-browser suite: a real Chromium with a fake camera + mic, the
// built app, the real backend. Users are registered through the real API.
import { chromium } from 'playwright-core';

export const API = process.env.API_URL || 'http://localhost:4100';
export const APP = process.env.APP_URL || 'http://localhost:4173';
export const T = { timeout: 180_000 };
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';

let browser = null;
const contexts = new Set();

export async function startBrowser() {
  browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      // 3 fake cameras: Chromium's fake_device_1 does not encode, see camera-switch/e2e/harness.html
      '--use-fake-device-for-media-stream=device-count=3',
      '--autoplay-policy=no-user-gesture-required',
      // E2E_HOST_MAP=vibenbones.online: test the real nginx config on THIS machine. Without the
      // mapping, and with an outbound proxy in the environment, Chromium would load the public
      // site instead. (No proxy: web fonts don't load in this mode, which no test depends on.)
      ...(process.env.E2E_HOST_MAP ? [
        `--host-resolver-rules=MAP ${process.env.E2E_HOST_MAP} 127.0.0.1, MAP *.${process.env.E2E_HOST_MAP} 127.0.0.1`,
        '--no-proxy-server',
      ] : []),
    ],
  });
}
export async function stopBrowser() { await cleanup(); await browser?.close(); browser = null; }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, { timeout = 20_000, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

let n = 0;
export async function newUser(prefix = 'u') {
  const tag = `${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const handle = `${prefix}_${tag}`.slice(0, 24);
  const email = `${handle.toLowerCase()}@e2e.test`;
  const password = 'correct horse battery';
  const res = await fetch(`${API}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle, email, password }) });
  const body = await res.json();
  if (res.status !== 201) throw new Error(`register failed ${res.status}: ${JSON.stringify(body)}`);
  return { handle, email, password, user: body.user, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

// RTCPeerConnections are recorded so a test can ask which ICE path media actually took
const RECORD_PCS = () => {
  const Orig = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = function RecordedPC(...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
  window.RTCPeerConnection.prototype = Orig.prototype;
};

async function newContext({ colorScheme = 'light', session = null, relay = false } = {}) {
  // E2E_INSECURE=1: testing the real nginx config locally with a self-signed certificate
  const ctx = await browser.newContext({ colorScheme, permissions: ['camera', 'microphone'], viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: !!process.env.E2E_INSECURE });
  contexts.add(ctx);
  await ctx.addInitScript(RECORD_PCS);
  if (session || relay) {
    await ctx.addInitScript(({ s, relayOnly }) => {
      if (window.__seeded) return;
      window.__seeded = true;
      // only seed a fresh tab: a reload after "log out" must stay logged out
      if (s && !sessionStorage.getItem('e2eSeeded')) {
        sessionStorage.setItem('e2eSeeded', '1');
        localStorage.setItem('kmUser', JSON.stringify(s.user));
        localStorage.setItem('kmAccessToken', s.accessToken);
        localStorage.setItem('kmRefreshToken', s.refreshToken);
      }
      if (relayOnly) localStorage.setItem('kmIceTransportPolicy', 'relay');
    }, { s: session, relayOnly: relay });
  }
  return ctx;
}

function track(page) {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  if (process.env.E2E_DEBUG) page.on('console', (m) => console.log(`[${page.label || 'page'}]`, m.text()));
  return page;
}

// a signed-in tab for user `u` (its own browser profile, like a separate device)
export async function openPage(u, opts = {}) {
  const ctx = await newContext({ ...opts, session: u });
  const page = track(await ctx.newPage());
  page.label = u.handle;
  return page;
}
export async function openAnon(opts = {}) {
  const ctx = await newContext(opts);
  return track(await ctx.newPage());
}

// is there a <video> in this tile that is actually decoding frames?
async function tileVideoPlaying(page, sel) {
  return page.evaluate(async (s) => {
    const v = document.querySelector(s);
    if (!v || !v.srcObject) return false;
    const before = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : v.currentTime;
    await new Promise((r) => setTimeout(r, 400));
    const after = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : v.currentTime;
    return v.videoWidth > 0 && after > before;
  }, sel);
}

export async function waitLive(page) {
  await page.locator('.live-room').waitFor({ timeout: 20_000 });
  await until(() => tileVideoPlaying(page, '.lr-tile[data-self="1"] video'), { timeout: 25_000, what: `${page.label}: own camera on stage` });
}

export async function goLive(page, title) {
  await page.goto(`${APP}/panels?golive=1`);
  if (title) await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: '● Go Live Now' }).click();
  await waitLive(page);
}

export async function joinFromList(page, title) {
  await page.goto(`${APP}/panels`);
  await page.getByRole('button', { name: `Join ${title}` }).click();
  await waitLive(page);
}

// handles shown on the stage, in order
export const tiles = (page) => page.$$eval('.lr-tile .lr-tile-label', (els) => els.map((e) => e.textContent));

// is `handle`'s video playing on this page (a remote tile, not our own)?
export async function playing(page, handle) {
  const idx = await page.$$eval('.lr-tile', (els, h) => els.findIndex((e) => !e.dataset.self && e.querySelector('.lr-tile-label')?.textContent.includes(h)), handle);
  if (idx < 0) return false;
  return tileVideoPlaying(page, `.lr-tile:nth-child(${idx + 1}) video`);
}

// for each live connection in the page, the ICE candidate pair it actually uses
export function candidateTypes(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs || []) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach((s) => byId.set(s.id, s));
      stats.forEach((s) => {
        if (s.type !== 'transport' || !s.selectedCandidatePairId) return;
        const pair = byId.get(s.selectedCandidatePairId);
        const local = byId.get(pair?.localCandidateId);
        out.push({ local: local?.candidateType, remote: byId.get(pair?.remoteCandidateId)?.candidateType, protocol: local?.protocol });
      });
    }
    return out;
  });
}

// a host live, a guest on stage, each seeing the other's video
export async function twoPeople() {
  const host = await newUser('host'); const guest = await newUser('guest');
  const hostPage = await openPage(host); await goLive(hostPage);
  const guestPage = await openPage(guest); await joinFromList(guestPage, `${host.handle}'s Stream`);
  await until(async () => (await playing(hostPage, guest.handle)) && (await playing(guestPage, host.handle)), { timeout: 30_000, what: 'video both ways' });
  return { host, guest, hostPage, guestPage };
}

export async function cleanup() {
  await Promise.all([...contexts].map((c) => c.close().catch(() => {})));
  contexts.clear();
}
