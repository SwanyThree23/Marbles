// Real-browser tests: live chat, reactions, server-side moderation, tipping,
// the Stripe return page, and dark/light theming that follows the system.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { API, APP, T, startBrowser, stopBrowser, sleep, until, newUser, openPage, openAnon, goLive, joinFromList, waitLive, tiles, twoPeople, cleanup } from './helpers.mjs';

before(startBrowser);
after(stopBrowser);

const chatInput = (page) => page.getByPlaceholder('Say something…');
async function say(page, text) { await chatInput(page).fill(text); await chatInput(page).press('Enter'); }
const heard = (page, text) => page.locator('.lc-msg', { hasText: text });

test('chat: a message typed in one browser shows up in the other, and for the sender, with the author', T, async () => {
  try {
    const { host, guest, hostPage, guestPage } = await twoPeople();
    await say(guestPage, 'hello from the guest');
    for (const page of [hostPage, guestPage]) await heard(page, 'hello from the guest').waitFor({ timeout: 10_000 });
    assert.equal(await heard(hostPage, 'hello from the guest').locator('b').innerText(), guest.handle);
    await say(hostPage, 'welcome in!');
    for (const page of [hostPage, guestPage]) await heard(page, 'welcome in!').waitFor({ timeout: 10_000 });
    assert.equal(await heard(guestPage, 'welcome in!').locator('b').innerText(), host.handle);
    assert.deepEqual([...hostPage.errors, ...guestPage.errors], []);
  } finally { await cleanup(); }
});

test('reactions: one in a browser floats up in the other', T, async () => {
  try {
    const { hostPage, guestPage } = await twoPeople();
    await guestPage.locator('button[title="React 🔥"]').click();
    await hostPage.locator('.lc-float', { hasText: '🔥' }).first().waitFor({ timeout: 8_000 });
  } finally { await cleanup(); }
});

test('moderation end to end: host sets a list in the UI; a blocked message reaches NOBODY; the host is flagged', T, async () => {
  try {
    const host = await newUser('host'); const a = await newUser('guest'); const b = await newUser('guest');

    const settings = await openPage(host);                          // the host's settings page, in the real UI
    await settings.goto(`${APP}/me`);
    await settings.getByLabel(/Block messages containing/).check();
    await settings.getByPlaceholder(/One word or phrase/).fill('scammer\nspam');
    await settings.locator('.settings-card', { hasText: 'Live Chat Moderation' }).getByRole('button', { name: 'Save' }).click();
    await settings.getByText('✓ Saved').waitFor({ timeout: 10_000 });

    const hostPage = await openPage(host); await goLive(hostPage);
    const aPage = await openPage(a); await joinFromList(aPage, `${host.handle}'s Stream`);
    const bPage = await openPage(b); await joinFromList(bPage, `${host.handle}'s Stream`);

    await say(aPage, 'you absolute SCAMMER');
    await aPage.getByText(/breaks the host's chat rules/).waitFor({ timeout: 10_000 });   // the sender is told
    await until(async () => /1/.test(await hostPage.getByTitle('Messages blocked by your chat rules').innerText()), { what: 'host flag count to reach 1' });
    await sleep(1200);
    assert.equal(await heard(bPage, 'SCAMMER').count(), 0, 'another viewer received a blocked message');
    assert.equal(await heard(hostPage, 'SCAMMER').count(), 0, 'the host\'s chat shows a blocked message');
    assert.equal(await heard(aPage, 'SCAMMER').count(), 0, 'the sender sees their own blocked message as if delivered');

    await say(aPage, 'a spamless lovely day');                       // contains "spam" but not as a word
    await heard(bPage, 'a spamless lovely day').waitFor({ timeout: 10_000 });

    await hostPage.getByTitle('Messages blocked by your chat rules').click();
    const flag = hostPage.locator('.lc-flag');
    await flag.waitFor();
    assert.match(await flag.innerText(), new RegExp(`${a.handle}.*SCAMMER.*blocked: scammer`, 's'));
    assert.equal(await heard(bPage, 'a spamless').count(), 1);
    assert.equal(await bPage.getByTitle('Messages blocked by your chat rules').count(), 0, 'viewers do not get the host badge');
  } finally { await cleanup(); }
});

test('tipping: viewers get 💰, the host does not; a host without payouts gets a clear message', T, async () => {
  try {
    const { hostPage, guestPage } = await twoPeople();
    assert.equal(await hostPage.getByTitle('Send a tip').count(), 0);
    await guestPage.getByTitle('Send a tip').click();
    await guestPage.getByText('💰 Send a Tip').waitFor();
    await guestPage.getByRole('button', { name: 'Continue to payment' }).click();
    await guestPage.getByText('This host has not set up payouts yet').waitFor({ timeout: 10_000 });
    assert.equal(guestPage.url().includes('stripe'), false, 'must not navigate to Stripe when the host cannot be paid');
  } finally { await cleanup(); }
});

test('the Stripe return page /live/:id?tip=success shows a thank-you and puts the viewer back in the live room', T, async () => {
  try {
    const { host, hostPage } = await twoPeople();
    const rooms = await (await fetch(`${API}/api/rooms?status=live`)).json();
    const room = rooms.find((r) => r.host_handle === host.handle);
    const viewer = await newUser('guest');
    const vPage = await openPage(viewer);
    await vPage.goto(`${APP}/live/${room.id}?tip=success`);
    await vPage.getByText(/your tip was sent/).waitFor({ timeout: 15_000 });
    await waitLive(vPage);
    await until(async () => (await tiles(hostPage)).length === 3, { what: 'the returning viewer on stage' });
  } finally { await cleanup(); }
});

// ---------- theming ----------
const themeOf = (page) => page.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-theme'),
  bg: getComputedStyle(document.body).backgroundColor,
  text: getComputedStyle(document.body).color,
}));
const lum = ([r, g, b]) => { const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const DARK_BG = 'rgb(12, 8, 6)'; const LIGHT_BG = 'rgb(251, 247, 239)';

test('theme: the page follows the system light/dark setting, including a live switch', T, async () => {
  try {
    for (const [scheme, bg] of [['dark', DARK_BG], ['light', LIGHT_BG]]) {
      const page = await openAnon({ colorScheme: scheme });
      await page.goto(APP);
      await page.getByText('Log In').first().waitFor();
      const t = await themeOf(page);
      assert.equal(t.attr, scheme);
      assert.equal(t.bg, bg, `${scheme}: the page background really is the ${scheme} palette`);
      assert.ok(ratio(t.text, t.bg) >= 4.5, `${scheme}: rendered body text contrast ${ratio(t.text, t.bg).toFixed(1)}`);
    }
    const page = await openAnon({ colorScheme: 'light' });          // now flip the OS setting while the page is open
    await page.goto(APP); await page.getByText('Log In').first().waitFor();
    assert.equal((await themeOf(page)).attr, 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await until(async () => (await themeOf(page)).bg === DARK_BG, { what: 'the page to switch to dark when the OS does' });
    await page.emulateMedia({ colorScheme: 'light' });
    await until(async () => (await themeOf(page)).bg === LIGHT_BG, { what: 'the page to switch back to light' });
  } finally { await cleanup(); }
});

test('theme: a manual choice wins over the system, survives a reload without flashing, and "System" resumes following', T, async () => {
  try {
    const u = await newUser('theme');
    const page = await openPage(u, { colorScheme: 'light' });
    await page.goto(`${APP}/me`);
    await page.getByText('Appearance').waitFor();
    assert.equal((await themeOf(page)).attr, 'light');

    await page.getByRole('button', { name: '🌙 Dark' }).click();
    assert.equal((await themeOf(page)).bg, DARK_BG);
    await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' }); await page.emulateMedia({ colorScheme: 'light' });
    assert.equal((await themeOf(page)).attr, 'dark', 'an explicit choice must not be overridden by the OS');

    await page.reload({ waitUntil: 'domcontentloaded' });            // checked BEFORE the app has rendered
    assert.equal((await themeOf(page)).attr, 'dark', 'the saved choice must be applied before first paint (no flash)');

    await page.getByRole('button', { name: '🖥️ System' }).click();
    assert.equal((await themeOf(page)).attr, 'light');               // follows the OS again (light)
    await page.emulateMedia({ colorScheme: 'dark' });
    await until(async () => (await themeOf(page)).attr === 'dark', { what: 'live following to resume' });

    fs.mkdirSync('/tmp/shots', { recursive: true });                 // pictures for a human to look at (not asserted)
    await page.screenshot({ path: '/tmp/shots/me-dark.png' });
    await page.getByRole('button', { name: '☀️ Light' }).click();
    await page.screenshot({ path: '/tmp/shots/me-light.png' });
    const card = await page.evaluate(() => {
      const c = document.querySelector('.settings-card'); const m = c.querySelector('.muted');
      return { bg: getComputedStyle(c).backgroundColor, dim: getComputedStyle(m).color };
    });
    assert.ok(ratio(card.dim, card.bg) >= 4.5, `light: dim text on a card ${ratio(card.dim, card.bg).toFixed(1)}:1`);
  } finally { await cleanup(); }
});

test('no flash: with ALL of the app\'s JavaScript blocked, the saved choice and the system setting are already applied from the HTML', T, async () => {
  try {
    const u = await newUser('flash');
    const page = await openPage(u, { colorScheme: 'light' });
    await page.goto(`${APP}/me`);
    await page.getByRole('button', { name: '🌙 Dark' }).click();            // saved choice: dark (system is light)
    await page.route('**/assets/*.js', (route) => route.abort());          // the app can no longer run any code
    await page.reload({ waitUntil: 'domcontentloaded' });
    let t = await themeOf(page);
    assert.equal(t.attr, 'dark', 'the saved choice must be applied before any app code runs');
    assert.equal(t.bg, DARK_BG, 'and the page must already be painted with that palette');

    const anon = await openAnon({ colorScheme: 'dark' });                  // no saved choice: the system setting
    await anon.route('**/assets/*.js', (route) => route.abort());
    await anon.goto(APP, { waitUntil: 'domcontentloaded' });
    t = await themeOf(anon);
    assert.equal(t.attr, 'dark');
    assert.equal(t.bg, DARK_BG);
  } finally { await cleanup(); }
});

test('light theme: text drawn OVER video (the name labels) stays readable', T, async () => {
  try {
    const host = await newUser('host');
    const page = await openPage(host, { colorScheme: 'light' });
    await goLive(page);
    assert.equal((await themeOf(page)).attr, 'light');
    const label = await page.evaluate(() => {
      const el = document.querySelector('.lr-tile-label');
      const s = getComputedStyle(el);
      return { text: s.color, bg: s.backgroundColor };
    });
    // the pill is a translucent black over video, so its text must be light: check it against black
    assert.ok(ratio(label.text, 'rgb(0, 0, 0)') >= 7, `label text ${label.text} on a dark pill has contrast ${ratio(label.text, 'rgb(0, 0, 0)').toFixed(1)}:1`);
  } finally { await cleanup(); }
});

test('phone: the header (notifications, Go Live, Log Out) is on screen and the page never scrolls sideways', T, async () => {
  try {
    const u = await newUser('phone');
    const page = await openPage(u, { colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/market', '/panels', '/me']) {
      await page.goto(`${APP}${route}`);
      await page.locator('.top-header').waitFor();
      const r = await page.evaluate(() => {
        const vw = window.innerWidth;
        const hits = ['.bell-btn', '.go-live-btn', '.logout-btn'].map((sel) => {
          const el = document.querySelector(sel); const b = el.getBoundingClientRect();
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          return { sel, left: b.left, right: b.right, covered: !(top === el || el.contains(top)) };
        });
        return { vw, hits, scrollW: document.documentElement.scrollWidth };
      });
      for (const h of r.hits) assert.ok(h.left >= 0 && h.right <= r.vw + 1 && !h.covered, `${route}: ${h.sel} is not fully on screen (${Math.round(h.left)}..${Math.round(h.right)} of ${r.vw}, covered ${h.covered})`);
      assert.ok(r.scrollW <= r.vw + 1, `${route}: the page scrolls sideways (content ${r.scrollW}px wide in a ${r.vw}px window)`);
      const first = await page.evaluate(() => { const a = document.querySelector('.top-header nav a'); const b = a.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth; });
      assert.ok(first, `${route}: the first nav link is not visible`);
    }
  } finally { await cleanup(); }
});
