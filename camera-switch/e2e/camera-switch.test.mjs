// Camera switching in REAL Chromium with two fake cameras and a real WebRTC connection.
// Chromium only: Firefox and WebKit in Playwright expose a single fake camera, and fake
// cameras report no facingMode, so this exercises the deviceId fallback. Chromium's
// fake_device_1 can't be encoded, so we launch 3 and hide it (see harness.html). Real facingMode
// on iPhone/Android is a manual check (see README).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const T = { timeout: 60_000 };

let server; let base;
const browsers = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = url.pathname === '/' ? 'e2e/harness.html' : url.pathname.slice(1);
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': full.endsWith('.js') ? 'text/javascript' : 'text/html' });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  await new Promise((r) => server.close(r));
});

async function open({ cameras = 3, query = '' } = {}) {   // 3: see the fake_device_1 note in harness.html
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-fake-ui-for-media-stream', `--use-fake-device-for-media-stream=device-count=${cameras}`],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e));
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => window.km, null, { timeout: 15_000 });
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (page) => page.evaluate(() => window.km.framesDecoded());
async function until(fn, { timeout = 10_000, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}

test('the browser offers two distinct, sendable cameras', T, async () => {
  const page = await open();
  const ids = await page.evaluate(() => window.km.cameras());
  assert.equal(ids.length, 2, `expected 2 cameras, got ${JSON.stringify(ids)}`);
  assert.notEqual(ids[0], ids[1]);
  await until(() => page.evaluate(() => window.km.canSwitch === true), { what: 'the switch button to be offered' });
});

test('switching cameras: the viewer keeps receiving video, the host sends the OTHER camera, no renegotiation, audio untouched', T, async () => {
  const page = await open();
  await until(async () => (await frames(page)) > 10, { what: 'video to start flowing' });
  const beforeId = await page.evaluate(() => window.km.senderDeviceId());

  const r = await page.evaluate(() => window.km.sw.switchCamera());
  assert.equal(r.ok, true, `switch failed: ${r.error}`);

  const afterId = await page.evaluate(() => window.km.senderDeviceId());
  assert.notEqual(afterId, beforeId, 'the sender is still on the old camera');
  assert.equal(await page.evaluate(() => window.km.senderState()), 'live');
  assert.equal(await page.evaluate(() => window.km.audioState()), 'live', 'audio was disturbed');
  assert.equal(await page.evaluate(() => window.km.remoteVideoState()), 'live', "the viewer's track ended");
  assert.equal(await page.evaluate(() => window.km.renegotiations), 0, 'switching renegotiated the connection');

  const f0 = await frames(page);
  await sleep(2000);
  const f1 = await frames(page);
  assert.ok(f1 - f0 > 20, `viewer frames stalled after the switch (${f0} -> ${f1})`);

  // and back again: the cycle wraps to the first camera
  const back = await page.evaluate(() => window.km.sw.switchCamera());
  assert.equal(back.ok, true);
  assert.equal(await page.evaluate(() => window.km.senderDeviceId()), beforeId);
  const f2 = await frames(page); await sleep(1500);
  assert.ok((await frames(page)) > f2 + 15, 'viewer frames stalled after switching back');
});

test('the local preview is mirrored for a front/unknown camera, never via the outgoing track', T, async () => {
  const page = await open();
  await page.evaluate(() => window.km.sw.switchCamera());
  // fake cameras report no facingMode -> treated as a front (laptop) camera -> preview mirrored
  assert.equal(await page.evaluate(() => window.km.preview.style.transform), 'scaleX(-1)');
  assert.equal(await page.evaluate(() => window.km.vSender.track.getSettings().facingMode ?? null), null);
});

test('with one camera the switch button is not offered', T, async () => {
  const page = await open({ cameras: 1 });
  await until(() => page.evaluate(() => window.km.canSwitch !== null), { what: 'the camera check' });
  assert.equal(await page.evaluate(() => window.km.canSwitch), false);
});

test('control: if replaceTrack does nothing, the viewer\'s video stalls (so the main test measures replaceTrack)', T, async () => {
  const page = await open({ query: '?break=replace' });
  await until(async () => (await frames(page)) > 10, { what: 'video to start flowing' });
  await page.evaluate(() => window.km.sw.switchCamera());
  await sleep(500);
  const f0 = await frames(page); await sleep(2000);
  const f1 = await frames(page);
  assert.ok(f1 - f0 <= 2, `frames kept flowing without replaceTrack (${f0} -> ${f1}) — the main test would be vacuous`);
});
