// The SAME person on two real devices (two browser contexts) and a stranger on a third:
// settings follow the person, the device list is live, and "sign out everywhere" is real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { API, APP, T, startBrowser, stopBrowser, until, newUser, openPage, cleanup } from './helpers.mjs';

before(startBrowser);
after(stopBrowser);

const themeAttr = (page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const devicesText = (page) => page.locator('.settings-card', { hasText: 'Your devices' }).innerText();

test('a theme chosen on one device appears on the same person\'s other device — and not on a stranger\'s', T, async () => {
  try {
    const me = await newUser('sync'); const them = await newUser('stranger');
    const desktop = await openPage(me, { colorScheme: 'light' });
    const phone = await openPage(me, { colorScheme: 'light' });
    const stranger = await openPage(them, { colorScheme: 'light' });
    await desktop.goto(`${APP}/me`); await phone.goto(`${APP}/market`); await stranger.goto(`${APP}/market`);
    await until(async () => /2 devices/.test(await devicesText(desktop)), { what: 'both devices connected' });
    assert.equal(await themeAttr(phone), 'light');

    await desktop.getByRole('button', { name: '🌙 Dark' }).click();
    await until(async () => (await themeAttr(phone)) === 'dark', { timeout: 8_000, what: 'the phone to turn dark' });
    assert.equal(await themeAttr(stranger), 'light', "another person's page changed");

    await desktop.getByRole('button', { name: '🖥️ System' }).click();               // back to "follow each device's own setting"
    await until(async () => (await themeAttr(phone)) === 'light', { timeout: 8_000, what: 'the phone to go back to its OWN system setting' });
    assert.equal(await themeAttr(desktop), 'light');
  } finally { await cleanup(); }
});

test('the phone\'s Appearance card follows a change made on the desktop', T, async () => {
  try {
    const me = await newUser('card');
    const desktop = await openPage(me, { colorScheme: 'light' }); const phone = await openPage(me, { colorScheme: 'light' });
    await desktop.goto(`${APP}/me`); await phone.goto(`${APP}/me`);
    await until(async () => /2 devices/.test(await devicesText(phone)), { what: 'both connected' });
    await desktop.getByRole('button', { name: '🌙 Dark' }).click();
    await until(async () => (await phone.getByRole('button', { name: '🌙 Dark' }).getAttribute('aria-pressed')) === 'true', { timeout: 8_000, what: "the phone's card to show Dark selected" });
  } finally { await cleanup(); }
});

test('the device list is live: a second device appears, and disappears when it goes away', T, async () => {
  try {
    const me = await newUser('list');
    const desktop = await openPage(me);
    await desktop.goto(`${APP}/me`);
    await until(async () => /Only this device/.test(await devicesText(desktop)), { what: 'one device' });
    const phone = await openPage(me); await phone.goto(`${APP}/market`);
    await until(async () => /2 devices/.test(await devicesText(desktop)), { what: 'the second device to appear' });
    assert.match(await devicesText(desktop), /this device/);
    await phone.context().close();                                                    // the phone goes away
    await until(async () => /Only this device/.test(await devicesText(desktop)), { timeout: 10_000, what: 'the second device to disappear' });
  } finally { await cleanup(); }
});

test('"Sign out of all devices" really ends the login everywhere (the other device\'s refresh token is dead)', T, async () => {
  try {
    const me = await newUser('out');
    const desktop = await openPage(me); const phone = await openPage(me);
    await desktop.goto(`${APP}/me`); await phone.goto(`${APP}/market`);
    await until(async () => /2 devices/.test(await devicesText(desktop)), { what: 'both connected' });
    const phoneRefresh = await phone.evaluate(() => localStorage.getItem('kmRefreshToken'));

    desktop.once('dialog', (d) => d.accept());
    await desktop.getByRole('button', { name: 'Sign out of all devices' }).click();
    await desktop.getByText('Log In').first().waitFor({ timeout: 10_000 });          // this device is signed out

    const res = await fetch(`${API}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: phoneRefresh }) });
    assert.equal(res.status, 401, "the phone's login was NOT revoked on the server");
  } finally { await cleanup(); }
});
