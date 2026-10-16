// The camera switch inside the real single-file preview (salvage/marbleverse-preview.html),
// in real Chromium with fake cameras. The preview has no peer connection (its camera only
// feeds the host's own tile), so "publish" means swapping the track inside its own stream.
// No backend: the live room is opened directly, and CDN/font requests are blocked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const T = { timeout: 60_000 };

let server; let base;
const browsers = [];
before(async () => {
  server = http.createServer((req, res) => {
    const full = path.join(REPO, 'salvage/marbleverse-preview.html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(full).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  await new Promise((r) => server.close(r));
});

async function hostLive({ cameras = 2 } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-fake-ui-for-media-stream', `--use-fake-device-for-media-stream=device-count=${cameras}`],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());          // offline: no CDN, fonts, API
  await page.addInitScript(() => {                                               // record every camera/mic request
    window.__gum = [];
    const md = navigator.mediaDevices; const real = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => { window.__gum.push(JSON.parse(JSON.stringify(c))); return real(c); };
  });
  await page.goto(base);
  await page.evaluate(() => openLiveRoom({ title: 'Camera test', host: 'Me' }, true));
  await page.waitForFunction(() => typeof myStream !== 'undefined' && myStream && myStream.getVideoTracks()[0]?.readyState === 'live', null, { timeout: 15_000 });
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flip = (page) => page.locator('#camFlipBtn');
const videoState = (page) => page.evaluate(() => {
  const v = myStream.getVideoTracks(); const a = myStream.getAudioTracks();
  return { videoCount: v.length, deviceId: v[0]?.getSettings().deviceId, live: v[0]?.readyState, enabled: v[0]?.enabled, audioId: a[0]?.id, audioLive: a[0]?.readyState };
});
// frames the host's own <video> actually paints in `ms`
const painted = (page, ms = 1200) => page.evaluate((ms) => new Promise((res) => {
  const v = document.getElementById('myVideo'); let n = 0;
  const cb = () => { n++; v.requestVideoFrameCallback(cb); };
  v.requestVideoFrameCallback(cb); setTimeout(() => res(n), ms);
}), ms);

test('preview: with 2 cameras the 🔄 button is offered and the old dropdown is gone', T, async () => {
  const page = await hostLive();
  await flip(page).waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.locator('.cam-select').count(), 0);
  assert.equal(await flip(page).getAttribute('aria-label'), 'Switch camera');
});

test('preview: switching swaps ONLY the video track — new camera painting, old one stopped, mic untouched and never re-requested', T, async () => {
  const page = await hostLive();
  await flip(page).waitFor({ state: 'visible', timeout: 10_000 });
  const before = await videoState(page);
  const oldTrack = await page.evaluateHandle(() => myStream.getVideoTracks()[0]);
  const gumBefore = (await page.evaluate(() => window.__gum.length));

  await flip(page).click();
  await page.waitForFunction((id) => myStream.getVideoTracks()[0]?.getSettings().deviceId !== id, before.deviceId, { timeout: 10_000 });

  const after = await videoState(page);
  assert.equal(after.videoCount, 1, 'exactly one video track in the stream');
  assert.equal(after.live, 'live');
  assert.equal(after.audioId, before.audioId, 'the mic track was replaced');
  assert.equal(after.audioLive, 'live', 'the mic was stopped');
  assert.equal(await oldTrack.evaluate((t) => t.readyState), 'ended', 'the old camera is still running');
  const newCalls = await page.evaluate((n) => window.__gum.slice(n), gumBefore);
  assert.ok(newCalls.length >= 1 && newCalls.every((c) => !c.audio), `switching asked for the mic again: ${JSON.stringify(newCalls)}`);
  assert.ok((await painted(page)) > 10, 'the host tile is not painting frames from the new camera');
  assert.deepEqual(page.errors, []);
});

test('preview: a camera turned OFF stays off after switching', T, async () => {
  const page = await hostLive();
  await flip(page).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#camBtn').click();
  assert.equal((await videoState(page)).enabled, false);
  const id = (await videoState(page)).deviceId;
  await flip(page).click();
  await page.waitForFunction((id) => myStream.getVideoTracks()[0]?.getSettings().deviceId !== id, id, { timeout: 10_000 });
  assert.equal((await videoState(page)).enabled, false, 'switching turned the camera back on');
});

test('preview: the host preview is mirrored (front/laptop camera)', T, async () => {
  const page = await hostLive();
  await flip(page).waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.evaluate(() => document.getElementById('myVideo').style.transform), 'scaleX(-1)');
});

test('preview: with one camera there is no switch button', T, async () => {
  const page = await hostLive({ cameras: 1 });
  await sleep(1500);
  assert.equal(await flip(page).isVisible(), false);
});
