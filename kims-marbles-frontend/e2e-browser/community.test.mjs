// Reporting -> the moderators' queue -> removal, and the watch party, in real browsers.
// The YouTube player is replaced by a local stub that records the commands it receives, so the
// test needs no network and proves exactly what the host's buttons send to viewers' players.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { APP, T, startBrowser, stopBrowser, until, newUser, openPage, twoPeople, cleanup } from './helpers.mjs';

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

const STUB = `<!doctype html><html><body>player stub<script>
  addEventListener('message', (e) => parent.postMessage({ stubGot: e.data }, '*'));
</script></body></html>`;
async function stubYoutube(page) {
  await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ contentType: 'text/html', body: STUB }));
  await page.addInitScript(() => {
    window.__playerCmds = [];
    addEventListener('message', (e) => { if (e.data && e.data.stubGot) window.__playerCmds.push(JSON.parse(e.data.stubGot).func); });
  });
}

test('watch party: the host plays a link for everyone and controls every viewer\'s player; a viewer can suggest one', T, async () => {
  try {
    const host = await newUser('host'); const guest = await newUser('guest');
    const hostPage = await openPage(host); const guestPage = await openPage(guest);
    await stubYoutube(hostPage); await stubYoutube(guestPage);
    const { goLive, joinFromList } = await import('./helpers.mjs');
    await goLive(hostPage);
    await joinFromList(guestPage, `${host.handle}'s Stream`);

    await guestPage.getByTitle('Watch party').click();
    await guestPage.getByLabel('YouTube link').fill('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    await guestPage.getByLabel('Video title (optional)').fill('Guest pick');
    await guestPage.getByRole('button', { name: 'Suggest to the host' }).click();

    await hostPage.getByTitle('Watch party').click();
    await hostPage.locator('.wp-queue-item', { hasText: 'Guest pick' }).waitFor({ timeout: 10_000 });
    await hostPage.getByLabel('YouTube link').fill('https://youtu.be/dQw4w9WgXcQ');
    await hostPage.getByLabel('Video title (optional)').fill('Marble run finals');
    await hostPage.getByRole('button', { name: 'Play for everyone' }).click();

    const frame = guestPage.getByTitle('Watch party: Marble run finals');
    await frame.waitFor({ timeout: 10_000 });
    assert.match(await frame.getAttribute('src'), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    await guestPage.waitForTimeout(500); // the stub frame loads
    await hostPage.getByTitle('Pause for everyone').click();
    await hostPage.getByTitle('From the start for everyone').click();
    await until(async () => (await guestPage.evaluate(() => window.__playerCmds.join(','))) === 'pauseVideo,seekTo,playVideo', { what: "the guest's player to get pause, then restart" });
    assert.equal(await guestPage.getByTitle('Pause for everyone').count(), 0, 'viewers do not get the controls');

    // someone arriving later sees what is playing
    const late = await newUser('late'); const latePage = await openPage(late); await stubYoutube(latePage);
    await joinFromList(latePage, `${host.handle}'s Stream`);
    await latePage.getByTitle('Watch party: Marble run finals').waitFor({ timeout: 10_000 });
    assert.deepEqual([...hostPage.errors, ...guestPage.errors, ...latePage.errors], []);
    void twoPeople;
  } finally { await cleanup(); }
});
