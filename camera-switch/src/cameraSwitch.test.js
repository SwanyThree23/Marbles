// Front/back camera switching, with a fake mediaDevices so every branch is exercised:
// facingMode on real phones, the deviceId fallback that desktops and Chromium's fake
// cameras need, stop-before-open, mirroring, button visibility, and restore-on-failure.
import { describe, test, expect, vi } from 'vitest';
import { createCameraSwitcher, shouldMirror } from './cameraSwitch.js';

const err = (name) => Object.assign(new Error(name), { name });

// cams: [{ id, facing? }]. facingSupported=false behaves like Chromium's fake devices
// (no facingMode, so an `exact` facing request is an OverconstrainedError).
function fakeDevices({ cams, facingSupported = true, permission = true, exclusive = true, failOpen = () => null } = {}) {
  const log = [];
  const open = new Set();
  const listeners = new Set();
  const makeTrack = (cam) => {
    const t = {
      kind: 'video', readyState: 'live', deviceId: cam.id,
      stop: vi.fn(() => { if (t.readyState === 'live') { t.readyState = 'ended'; open.delete(cam.id); log.push(`stop:${cam.id}`); } }),
      getSettings: () => ({ deviceId: cam.id, ...(facingSupported && cam.facing ? { facingMode: cam.facing } : {}) }),
    };
    open.add(cam.id);
    return t;
  };
  const md = {
    log,
    cams,
    calls: [],
    getUserMedia: vi.fn(async (c) => {
      md.calls.push(c);
      const v = c.video || {};
      let cam;
      if (v.facingMode) {
        const want = v.facingMode.exact;
        cam = facingSupported ? cams.find((x) => x.facing === want) : null;
        if (!cam) throw err('OverconstrainedError');
      } else if (v.deviceId) {
        cam = cams.find((x) => x.id === v.deviceId.exact);
        if (!cam) throw err('OverconstrainedError');
      } else cam = cams[0];
      const forced = failOpen(cam);
      if (forced) throw err(forced);
      if (exclusive && open.size) throw err('NotReadableError'); // Android: one camera at a time
      log.push(`open:${cam.id}`);
      const track = makeTrack(cam);
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    }),
    enumerateDevices: vi.fn(async () => [
      { kind: 'audioinput', deviceId: permission ? 'mic' : '', label: '' },
      ...cams.map((c) => ({ kind: 'videoinput', deviceId: permission ? c.id : '', label: permission ? c.id : '' })),
    ]),
    addEventListener: (type, fn) => type === 'devicechange' && listeners.add(fn),
    removeEventListener: (type, fn) => type === 'devicechange' && listeners.delete(fn),
    fireDeviceChange: () => listeners.forEach((fn) => fn()),
    openTrack: (id) => makeTrack(cams.find((c) => c.id === id)),
  };
  return md;
}

const FRONT_BACK = [{ id: 'front', facing: 'user' }, { id: 'back', facing: 'environment' }];

function setup(opts, startId = 'front') {
  const md = fakeDevices(opts);
  const sent = [];
  const replaceTrack = vi.fn(async (t) => { sent.push(t); });
  const onTrack = vi.fn();
  const sw = createCameraSwitcher({ mediaDevices: md, replaceTrack, onTrack });
  sw.start(md.openTrack(startId));
  return { md, sw, sent, replaceTrack, onTrack };
}

describe('switching on a real phone (facingMode works)', () => {
  test('asks for the other facing with `exact`, publishes it with replaceTrack, and never touches audio', async () => {
    const { md, sw, sent, onTrack } = setup({ cams: FRONT_BACK });
    const r = await sw.switchCamera();
    expect(r.ok).toBe(true);
    expect(md.calls[0].video.facingMode).toEqual({ exact: 'environment' });
    expect(md.calls.every((c) => !c.audio)).toBe(true);
    expect(sent.at(-1).deviceId).toBe('back');
    expect(r.facing).toBe('environment');
    expect(onTrack).toHaveBeenLastCalledWith(sent.at(-1), { facing: 'environment', mirror: false });

    const back = await sw.switchCamera();
    expect(md.calls.at(-1).video.facingMode).toEqual({ exact: 'user' });
    expect(back.facing).toBe('user');
    expect(sent.at(-1).deviceId).toBe('front');
  });
});

describe('fallback to deviceId (desktops, Chromium fake cameras: no facingMode)', () => {
  test('OverconstrainedError on facingMode -> opens the NEXT videoinput by deviceId', async () => {
    const { md, sw, sent } = setup({ cams: [{ id: 'cam0' }, { id: 'cam1' }], facingSupported: false }, 'cam0');
    const r = await sw.switchCamera();
    expect(r.ok).toBe(true);
    expect(md.calls[0].video.facingMode).toEqual({ exact: 'environment' });
    expect(md.calls[1].video.deviceId).toEqual({ exact: 'cam1' });
    expect(sent.at(-1).deviceId).toBe('cam1');
  });

  test('cycles through every camera and wraps around', async () => {
    const { sw, sent } = setup({ cams: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], facingSupported: false }, 'a');
    const seen = [];
    for (let i = 0; i < 4; i++) { await sw.switchCamera(); seen.push(sent.at(-1).deviceId); }
    expect(seen).toEqual(['b', 'c', 'a', 'b']);
  });

  test('a non-constraint error from facingMode (e.g. permission) is NOT treated as "try the next device"', async () => {
    const { md, sw } = setup({ cams: FRONT_BACK, failOpen: (cam) => (cam.id === 'back' ? 'NotAllowedError' : null) });
    const r = await sw.switchCamera();
    expect(r.ok).toBe(false);
    expect(md.calls.filter((c) => c.video.deviceId?.exact === 'back')).toHaveLength(0);
  });
});

describe('stop before open', () => {
  test('the old camera is stopped before the new one is opened (phones that allow one camera at a time)', async () => {
    const { md, sw } = setup({ cams: FRONT_BACK, exclusive: true });
    const r = await sw.switchCamera();
    expect(r.ok).toBe(true);
    expect(md.log).toEqual(['stop:front', 'open:back']);
  });
});

describe('mirroring', () => {
  test('front (and unknown, i.e. a laptop webcam) is mirrored; back never is', () => {
    expect(shouldMirror('user')).toBe(true);
    expect(shouldMirror(undefined)).toBe(true);
    expect(shouldMirror('environment')).toBe(false);
  });

  test('the preview mirror flag follows the camera; the published track is the raw track', async () => {
    const { sw, sent, onTrack } = setup({ cams: FRONT_BACK });
    expect(sw.mirror).toBe(true);
    await sw.switchCamera();
    expect(sw.mirror).toBe(false);
    expect(onTrack.mock.calls.at(-1)[1].mirror).toBe(false);
    await sw.switchCamera();
    expect(sw.mirror).toBe(true);
    // what goes to viewers is exactly what getUserMedia returned: no mirrored copy
    expect(sent.every((t) => typeof t.getSettings === 'function')).toBe(true);
  });
});

describe('when the switch button shows', () => {
  test('hidden with one camera', async () => {
    const { sw } = setup({ cams: [{ id: 'only', facing: 'user' }] }, 'only');
    expect(await sw.refresh()).toBe(1);
    expect(sw.canSwitch).toBe(false);
  });

  test('hidden before permission (ids are blank), shown with 2+ after', async () => {
    const before = setup({ cams: FRONT_BACK, permission: false });
    await before.sw.refresh();
    expect(before.sw.canSwitch).toBe(false);
    const after = setup({ cams: FRONT_BACK });
    await after.sw.refresh();
    expect(after.sw.canSwitch).toBe(true);
  });

  test('re-checks on devicechange (a camera plugged in / removed)', async () => {
    const { md, sw } = setup({ cams: [{ id: 'cam0' }] }, 'cam0');
    const seen = [];
    const stop = sw.watch((can) => seen.push(can));
    await vi.waitFor(() => expect(seen).toEqual([false]));
    md.cams.push({ id: 'cam1' });
    md.fireDeviceChange();
    await vi.waitFor(() => expect(seen).toEqual([false, true]));
    stop();
    md.cams.pop();
    md.fireDeviceChange();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([false, true]);
  });
});

describe('a failed switch never leaves the stream black', () => {
  test('new camera cannot open -> the previous camera is reopened and republished', async () => {
    const { sw, sent, onTrack } = setup({ cams: FRONT_BACK, failOpen: (cam) => (cam.id === 'back' ? 'NotReadableError' : null) });
    const r = await sw.switchCamera();
    expect(r).toMatchObject({ ok: false, restored: true });
    expect(r.error).toMatch(/NotReadableError/);
    expect(sent.at(-1).deviceId).toBe('front');
    expect(sent.at(-1).readyState).toBe('live');
    expect(onTrack).toHaveBeenLastCalledWith(sent.at(-1), { facing: 'user', mirror: true });
    expect(sw.track).toBe(sent.at(-1));
  });

  test('replaceTrack rejects -> the new camera is released and the previous one restored', async () => {
    const md = fakeDevices({ cams: FRONT_BACK });
    const sent = [];
    const replaceTrack = vi.fn(async (t) => { if (t.deviceId === 'back') throw new Error('transport closed'); sent.push(t); });
    const sw = createCameraSwitcher({ mediaDevices: md, replaceTrack, onTrack: () => {} });
    sw.start(md.openTrack('front'));
    const r = await sw.switchCamera();
    expect(r).toMatchObject({ ok: false, restored: true });
    const backTrack = (await md.getUserMedia.mock.results.find((x, i) => md.calls[i].video.facingMode?.exact === 'environment').value).getVideoTracks()[0];
    expect(backTrack.readyState).toBe('ended');
    expect(sent.at(-1).deviceId).toBe('front');
  });

  test('restore also fails -> reports it so the UI can say the camera is off', async () => {
    const { sw } = setup({ cams: FRONT_BACK, failOpen: () => 'NotReadableError' });
    const r = await sw.switchCamera();
    expect(r).toMatchObject({ ok: false, restored: false });
    expect(sw.track).toBe(null);
  });
});

describe('robustness', () => {
  test('a second tap while switching is ignored (one getUserMedia sequence)', async () => {
    const { md, sw } = setup({ cams: FRONT_BACK });
    const [a, b] = await Promise.all([sw.switchCamera(), sw.switchCamera()]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: 'busy' });
    expect(md.calls).toHaveLength(1);
  });

  test('switching before start() is a clear error, not a crash', async () => {
    const md = fakeDevices({ cams: FRONT_BACK });
    const sw = createCameraSwitcher({ mediaDevices: md, replaceTrack: async () => {}, onTrack: () => {} });
    expect(await sw.switchCamera()).toEqual({ ok: false, error: 'no camera' });
  });
});
