// Real media through the real SFU, in real browsers: video both ways, host controls reaching a
// guest's device, the same host on two devices (remote control + takeover), invite links,
// screen share, camera flip, a full stage of five, ending a stream, and (opt-in) a server
// restart mid-stream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { API, APP, T, startBrowser, stopBrowser, sleep, until, newUser, openPage, goLive, joinFromList, waitLive, tiles, playing, candidateTypes, twoPeople, cleanup } from './helpers.mjs';

before(startBrowser);
after(stopBrowser);

const selfTrack = (page) => page.evaluate(() => {
  const v = document.querySelector('.lr-tile[data-self="1"] video');
  const t = v?.srcObject?.getVideoTracks()[0];
  return t ? { id: t.id, label: t.label, deviceId: t.getSettings().deviceId } : null;
});
const remoteTrackId = (page, handle) => page.$$eval('.lr-tile', (els, h) => {
  const el = els.find((e) => !e.dataset.self && e.querySelector('.lr-tile-label')?.textContent.includes(h));
  return el?.querySelector('video')?.srcObject?.getVideoTracks()[0]?.id || null;
}, handle);

test('video plays both ways, each side hears an audio track, over one send and one receive connection to the SFU', T, async () => {
  try {
    const { host, guest, hostPage, guestPage } = await twoPeople();
    for (const [page, other] of [[hostPage, guest], [guestPage, host]]) {
      const audio = await page.$$eval('.lr-tile audio', (els) => els.map((a) => a.srcObject?.getAudioTracks()[0]?.readyState));
      assert.deepEqual(audio, ['live'], `${other.handle}'s audio is not reaching the page`);
    }
    const pairs = await candidateTypes(guestPage);
    assert.equal(pairs.length, 2, `expected a send and a receive connection, got ${JSON.stringify(pairs)}`);
    for (const p of pairs) assert.notEqual(p.local, 'relay', 'no TURN is configured, so nothing should be relayed');
    assert.deepEqual([...await tiles(hostPage)].sort(), [`★ ${host.handle} (you)`, guest.handle].sort());
    assert.deepEqual([...hostPage.errors, ...guestPage.errors], []);
  } finally { await cleanup(); }
});

test('host controls reach the guest\'s device: mute disables their mic, layout changes their screen', T, async () => {
  try {
    const { guest, hostPage, guestPage } = await twoPeople();
    await hostPage.getByTitle(`Mute ${guest.handle}`).click();
    await guestPage.getByTitle('The host muted you').waitFor({ timeout: 8_000 });
    await until(() => guestPage.evaluate(() => {
      // the guest's outgoing audio sender is really silent: its track is disabled
      return (window.__pcs || []).some((pc) => pc.getSenders().some((s) => s.track?.kind === 'audio' && s.track.enabled === false));
    }), { what: 'the guest mic track to be disabled' });
    await hostPage.locator('.lr-tile', { hasText: guest.handle }).locator('.lr-tile-badge', { hasText: '🔇' }).waitFor();
    await hostPage.getByTitle(`Unmute ${guest.handle}`).click();
    await guestPage.getByTitle('Mute microphone').waitFor({ timeout: 8_000 });

    await hostPage.getByTitle('Spotlight layout').click();
    await until(async () => (await guestPage.locator('.lr-stage').getAttribute('data-layout')) === 'spotlight', { what: 'guest layout to follow' });
    assert.equal(await guestPage.getByTitle('Spotlight layout').count(), 0, 'guests must not get host controls');
  } finally { await cleanup(); }
});

test('the same host on a second device becomes a remote control; "take over" moves the camera and viewers keep watching', T, async () => {
  try {
    const { host, guest, hostPage, guestPage } = await twoPeople();
    const roomUrl = hostPage.url();
    const second = await openPage(host);
    await second.goto(roomUrl);
    await second.getByText(/already live from another device/).waitFor({ timeout: 20_000 });
    assert.equal(await tiles(guestPage).then((t) => t.filter((x) => x.includes(host.handle)).length), 1, 'viewers must see the host once');
    await until(() => playing(second, host.handle), { what: 'the remote control to show the live stream' });

    // the remote control drives host controls
    await second.getByTitle('Spotlight layout').click();
    await until(async () => (await guestPage.locator('.lr-stage').getAttribute('data-layout')) === 'spotlight', { what: 'command from the second device' });

    const before = await remoteTrackId(guestPage, host.handle);
    await second.getByRole('button', { name: "Use this device's camera instead" }).click();
    await hostPage.getByText(/went live from another device/).waitFor({ timeout: 15_000 });
    await until(async () => { const id = await remoteTrackId(guestPage, host.handle); return id && id !== before && playing(guestPage, host.handle); }, { timeout: 30_000, what: 'viewers to get the new device\'s camera' });
    assert.equal(await tiles(guestPage).then((t) => t.filter((x) => x.includes(host.handle)).length), 1);
    await until(() => playing(second, guest.handle), { what: 'the new device to see the guest' });
  } finally { await cleanup(); }
});

test('invite link: one person gets on stage with it; a second person is refused', T, async () => {
  try {
    const host = await newUser('host'); const a = await newUser('inv'); const b = await newUser('inv');
    const hostPage = await openPage(host); await goLive(hostPage);
    await hostPage.getByTitle('Invite someone on stage').click();
    const url = (await hostPage.locator('.mono', { hasText: '/join/' }).innerText()).trim();
    assert.match(url, new RegExp(`^${APP}/join/[\\w-]{20,}$`));
    const aPage = await openPage(a); await aPage.goto(url); await waitLive(aPage);
    await until(() => playing(hostPage, a.handle), { what: 'invitee on stage' });
    const bPage = await openPage(b); await bPage.goto(url);
    await bPage.getByText('This invite has already been used').waitFor({ timeout: 10_000 });
  } finally { await cleanup(); }
});

test('screen share replaces the host\'s tile for viewers, and stopping it brings the camera back', T, async () => {
  try {
    const { host, hostPage, guestPage } = await twoPeople();
    const cam = await remoteTrackId(guestPage, host.handle);
    await hostPage.getByTitle('Share your screen').click();
    await until(async () => { const id = await remoteTrackId(guestPage, host.handle); return id && id !== cam && playing(guestPage, host.handle); }, { timeout: 20_000, what: 'viewer to see the shared screen' });
    await hostPage.getByTitle('Stop sharing your screen').click();
    await until(async () => (await remoteTrackId(guestPage, host.handle)) === cam && playing(guestPage, host.handle), { timeout: 20_000, what: 'the camera to come back' });
    assert.deepEqual(hostPage.errors, []);
  } finally { await cleanup(); }
});

test('camera flip: the host switches to another camera and viewers keep getting video', T, async () => {
  try {
    const host = await newUser('host'); const guest = await newUser('guest');
    const hostPage = await openPage(host);
    // Chromium's fake_device_1 draws locally but never encodes; hide it (camera-switch/e2e/harness.html)
    await hostPage.context().addInitScript(() => {
      const md = navigator.mediaDevices; const orig = md.enumerateDevices.bind(md);
      md.enumerateDevices = async () => (await orig()).filter((d) => d.label !== 'fake_device_1');
    });
    await goLive(hostPage);
    const guestPage = await openPage(guest); await joinFromList(guestPage, `${host.handle}'s Stream`);
    await until(() => playing(guestPage, host.handle), { what: 'guest sees host' });
    const before = await selfTrack(hostPage);
    await hostPage.getByTitle('Switch camera').click();
    await until(async () => { const t = await selfTrack(hostPage); return t && t.deviceId !== before.deviceId; }, { what: 'a different camera on the host' });
    const frames = () => guestPage.evaluate((h) => {
      const el = [...document.querySelectorAll('.lr-tile')].find((e) => !e.dataset.self && e.querySelector('.lr-tile-label')?.textContent.includes(h));
      return el?.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames || 0;
    }, host.handle);
    const f0 = await frames(); await sleep(1500);
    assert.ok((await frames()) > f0 + 10, 'viewer video froze after the flip');
  } finally { await cleanup(); }
});

test('a full stage of five: everyone sees and hears the other four', { timeout: 300_000 }, async () => {
  try {
    const host = await newUser('host');
    const hostPage = await openPage(host); await goLive(hostPage);
    const guests = [];
    for (let i = 0; i < 4; i++) {
      const g = await newUser('g'); const p = await openPage(g);
      await joinFromList(p, `${host.handle}'s Stream`);
      guests.push({ g, p });
    }
    const people = [{ g: host, p: hostPage }, ...guests];
    for (const { g, p } of people) {
      for (const other of people) {
        if (other.g === g) continue;
        await until(() => playing(p, other.g.handle), { timeout: 40_000, what: `${g.handle} to see ${other.g.handle}` });
      }
      assert.equal(await p.$$eval('.lr-tile audio', (els) => els.length), 4, `${g.handle} should receive 4 audio tracks`);
    }
  } finally { await cleanup(); }
});

test('ending the stream: guests are told and their camera turns off', T, async () => {
  try {
    const { host, hostPage, guestPage } = await twoPeople();
    hostPage.once('dialog', (d) => d.accept());
    await hostPage.getByRole('button', { name: 'End stream' }).click();
    await guestPage.getByText('This stream has ended.').waitFor({ timeout: 10_000 });
    await until(() => guestPage.evaluate(() => (window.__pcs || []).every((pc) => pc.getSenders().every((s) => !s.track || s.track.readyState === 'ended'))), { what: 'guest camera to stop' });
    const rooms = await (await fetch(`${API}/api/rooms?status=live`)).json();
    assert.equal(rooms.filter((r) => r.host_handle === host.handle).length, 0, 'the room is still listed as live');
  } finally { await cleanup(); }
});

// The server restarts mid-stream (deploy, crash). Opt-in: E2E_RESTART_CMD restarts the backend
// WITHOUT touching the database, e.g. the PID-based script used by the runner.
test('server restart mid-stream: both sides reconnect on their own and video flows again', { ...T, skip: !process.env.E2E_RESTART_CMD }, async () => {
  try {
    const { host, guest, hostPage, guestPage } = await twoPeople();
    execSync(process.env.E2E_RESTART_CMD, { stdio: 'inherit' });
    await guestPage.getByText(/Reconnecting/).waitFor({ timeout: 15_000 }).catch(() => {});
    await until(async () => (await playing(hostPage, guest.handle)) && (await playing(guestPage, host.handle)), { timeout: 60_000, what: 'video both ways after the restart' });
    assert.equal(await guestPage.getByText(/Reconnecting/).count(), 0);
    void APP;
  } finally { await cleanup(); }
});
