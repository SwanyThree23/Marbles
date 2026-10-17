// Reporting -> the moderators' queue -> removal, and the watch party, in real browsers.
// The YouTube player is replaced by a local stub that records the commands it receives, so the
// test needs no network and proves exactly what the host's buttons send to viewers' players.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { APP, T, startBrowser, stopBrowser, sleep, until, newUser, openPage, cleanup } from './helpers.mjs';

before(startBrowser);
after(stopBrowser);

const DB = process.env.E2E_DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/km_e2e_test';
function makeAdmin(u) {
  execFileSync('psql', [DB, '-q', '-c', `update users set is_admin = true where id = '${u.user.id}'`]);
  u.user = { ...u.user, is_admin: true };
}

test('a post reported by one person shows up for a moderator, who removes it for everyone', T, async () => {
  try {
    const author = await newUser('author'); const reader = await newUser('reader'); const mod = await newUser('mod');
    makeAdmin(mod);
    const a = await openPage(author); await a.goto(`${APP}/feed`);
    await a.getByPlaceholder(/Share a haul/).fill('Buy cheap followers at spam dot example');
    await a.getByRole('button', { name: 'Post', exact: true }).click();
    await a.locator('article', { hasText: 'cheap followers' }).waitFor();

    const r = await openPage(reader); await r.goto(`${APP}/feed`);
    const post = r.locator('article', { hasText: 'cheap followers' });
    await post.getByRole('button', { name: '⚑ Report' }).click();
    await r.getByLabel(/What's wrong/).selectOption('Spam');
    await r.getByRole('button', { name: 'Send report' }).click();
    await r.getByText('A moderator will review it').waitFor();
    assert.equal(await a.locator('article', { hasText: 'cheap followers' }).getByRole('button', { name: '⚑ Report' }).count(), 0, 'no Report on your own post');

    const m = await openPage(mod); await m.goto(`${APP}/market`);
    await m.getByRole('link', { name: '🛡️ Reports' }).click();
    const row = m.locator('.report-row', { hasText: 'cheap followers' });
    await row.waitFor();
    assert.match(await row.innerText(), new RegExp(`Spam[\\s\\S]*Reported by ${reader.handle}`));
    m.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Remove post' }).click();
    await until(async () => (await m.locator('.report-row', { hasText: 'cheap followers' }).count()) === 0, { what: 'the report to close' });

    await r.reload();
    await r.getByRole('heading', { name: 'Feed' }).waitFor();
    await until(async () => (await r.locator('article', { hasText: 'cheap followers' }).count()) === 0, { what: 'the post to be gone for readers' });
    assert.equal(await a.getByRole('link', { name: '🛡️ Reports' }).count(), 0, 'regular users have no Reports link');
  } finally { await cleanup(); }
});

// A stand-in for YouTube's embedded player that speaks its real postMessage protocol (checked
// against the real embed): it answers "listening" with onReady, reports infoDelivery
// {currentTime, playerState} every 250 ms, obeys playVideo / pauseVideo / seekTo, and starts
// playing by itself like autoplay=1. RATE < 1 makes a player that falls behind.
const stub = (rate = 1) => `<!doctype html><html><body style="background:#111;color:#eee">player stub<script>
  let t = 0, state = 1, last = performance.now(), ready = false;
  const tick = () => { const n = performance.now(); if (state === 1) t += ((n - last) / 1000) * ${rate}; last = n; };
  const tell = () => { tick(); parent.postMessage(JSON.stringify({ event: 'infoDelivery', info: { currentTime: t, playerState: state } }), '*'); };
  window.stubTime = () => { tick(); return { t, state }; };
  addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.event === 'listening' && !ready) { ready = true; parent.postMessage(JSON.stringify({ event: 'onReady', id: m.id }), '*'); setInterval(tell, 250); return; }
    if (m.event !== 'command') return;
    tick();
    if (m.func === 'playVideo') state = 1;
    if (m.func === 'pauseVideo') state = 2;
    if (m.func === 'seekTo') t = m.args[0];
    tell();
  });
</script></body></html>`;
async function stubYoutube(page, rate = 1) {
  await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ contentType: 'text/html', body: stub(rate) }));
}
const playerTime = async (page) => {
  const f = page.frames().find((x) => x.url().startsWith('https://www.youtube-nocookie.com/'));
  return f ? f.evaluate(() => window.stubTime()) : null;
};
async function gap(a, b) {
  const [x, y] = await Promise.all([playerTime(a), playerTime(b)]);
  return x && y ? { gap: Math.abs(x.t - y.t), a: x, b: y } : null;
}

test('watch party: everyone stays at the same second: play, pause, a late joiner, and a slow player', { timeout: 240_000 }, async () => {
  try {
    const { goLive, joinFromList } = await import('./helpers.mjs');
    const host = await newUser('host'); const guest = await newUser('guest');
    const hostPage = await openPage(host); const guestPage = await openPage(guest);
    await stubYoutube(hostPage); await stubYoutube(guestPage);
    await goLive(hostPage);
    await joinFromList(guestPage, `${host.handle}'s Stream`);

    // a viewer suggests; the host sees it
    await guestPage.getByTitle('Watch party').click();
    await guestPage.getByLabel('YouTube link').fill('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    await guestPage.getByLabel('Video title (optional)').fill('Guest pick');
    await guestPage.getByRole('button', { name: 'Suggest to the host' }).click();
    await hostPage.getByTitle('Watch party').click();
    await hostPage.locator('.wp-queue-item', { hasText: 'Guest pick' }).waitFor({ timeout: 10_000 });

    await hostPage.getByLabel('YouTube link').fill('https://youtu.be/dQw4w9WgXcQ');
    await hostPage.getByLabel('Video title (optional)').fill('Marble run finals');
    await hostPage.getByRole('button', { name: 'Play for everyone' }).click();
    assert.match(await guestPage.getByTitle('Watch party: Marble run finals').getAttribute('src'), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    await sleep(4000);
    let g = await gap(hostPage, guestPage);
    assert.ok(g && g.gap < 1.5 && g.a.state === 1 && g.b.state === 1, `both playing together: ${JSON.stringify(g)}`);

    await hostPage.getByTitle('Pause for everyone').click();
    await until(async () => { const x = await gap(hostPage, guestPage); return x && x.b.state === 2 && x.gap < 0.6; }, { what: 'the guest to pause at the host\'s second' });
    const pausedAt = (await playerTime(guestPage)).t;
    await sleep(1500);
    assert.ok(Math.abs((await playerTime(guestPage)).t - pausedAt) < 0.05, 'stays paused');

    await hostPage.getByTitle('Play for everyone').click();
    await sleep(4000);   // the host's heartbeat has moved the room clock on by now

    // a late joiner starts where everyone is, not at 0
    const late = await newUser('late'); const latePage = await openPage(late); await stubYoutube(latePage);
    await joinFromList(latePage, `${host.handle}'s Stream`);
    await latePage.getByTitle('Watch party: Marble run finals').waitFor({ timeout: 10_000 });
    await until(async () => { const x = await gap(hostPage, latePage); return x && x.b.t > 5 && x.gap < 1.5; }, { timeout: 15_000, what: 'the late joiner to catch up' });

    // a player that runs slow (60% speed) is kept in step by corrections
    const slow = await newUser('slow'); const slowPage = await openPage(slow); await stubYoutube(slowPage, 0.6);
    await joinFromList(slowPage, `${host.handle}'s Stream`);
    await slowPage.getByTitle('Watch party: Marble run finals').waitFor({ timeout: 10_000 });
    await sleep(15_000);   // uncorrected, it would now be ~6 s behind
    g = await gap(hostPage, slowPage);
    assert.ok(g && g.gap < 2.5, `the slow player is kept within a couple of seconds: ${JSON.stringify(g)}`);
    assert.equal(await guestPage.getByTitle('Pause for everyone').count(), 0, 'viewers do not get the controls');
    assert.deepEqual([...hostPage.errors, ...guestPage.errors, ...latePage.errors, ...slowPage.errors], []);
  } finally { await cleanup(); }
});

test('watch party: when the HOST\'s player falls behind (buffering), viewers follow the host, not a perfect clock', { timeout: 180_000 }, async () => {
  try {
    const { goLive, joinFromList } = await import('./helpers.mjs');
    const host = await newUser('host'); const guest = await newUser('guest');
    const hostPage = await openPage(host); const guestPage = await openPage(guest);
    await stubYoutube(hostPage, 0.7); await stubYoutube(guestPage, 1);
    await goLive(hostPage);
    await joinFromList(guestPage, `${host.handle}'s Stream`);
    await hostPage.getByTitle('Watch party').click();
    await hostPage.getByLabel('YouTube link').fill('dQw4w9WgXcQ');
    await hostPage.getByRole('button', { name: 'Play for everyone' }).click();
    await guestPage.getByTitle(/Watch party:/).waitFor({ timeout: 10_000 });
    await sleep(16_000);   // without the host's heartbeat the guest would now be ~5 s ahead
    const g = await gap(hostPage, guestPage);
    assert.ok(g && g.gap < 2.5, `the guest stays with the host: ${JSON.stringify(g)}`);
  } finally { await cleanup(); }
});
