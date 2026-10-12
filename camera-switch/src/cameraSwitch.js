// cameraSwitch.js — front/back camera switching for the live room.
//
// Real phones report facingMode, so we ask for the other side with `exact`. Desktops and
// Chromium's fake cameras report none, so `exact` fails with OverconstrainedError and we
// fall back to the next `videoinput` by deviceId. Many Android phones cannot hold two
// cameras open, so the old track is stopped BEFORE the new one is opened. The new track is
// published with replaceTrack (no renegotiation; audio untouched). If anything fails, the
// previous camera is reopened so a failed switch never leaves the stream black.
//
// Wiring (mediasoup-client): replaceTrack: (track) => videoProducer.replaceTrack({ track })
// (mediasoup-client takes an OBJECT; a plain RTCRtpSender takes the track itself).

const BASE_VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 } };

// Mirror the local preview for the front camera only. A camera that reports no facing is
// treated as front: that is a laptop webcam, which faces the user. Viewers are never sent a
// mirrored stream; mirroring is a CSS transform on the local <video> only.
export const shouldMirror = (facing) => facing !== 'environment';

const settingsOf = (track) => (track && typeof track.getSettings === 'function' ? track.getSettings() : {}) || {};

export function createCameraSwitcher({ mediaDevices, replaceTrack, onTrack = () => {}, video = BASE_VIDEO }) {
  let track = null;
  let busy = false;
  let cameras = [];

  const facingOf = (t) => settingsOf(t).facingMode;
  const open = async (constraints) => {
    const stream = await mediaDevices.getUserMedia({ audio: false, video: { ...video, ...constraints } });
    return stream.getVideoTracks()[0];
  };

  // Usable cameras only: before permission is granted, ids (and labels) are blank.
  async function refresh() {
    try {
      const list = await mediaDevices.enumerateDevices();
      cameras = list.filter((d) => d.kind === 'videoinput' && d.deviceId);
    } catch (_e) {
      cameras = [];
    }
    return cameras.length;
  }

  async function nextByDeviceId(currentId) {
    await refresh();
    if (cameras.length < 2) throw Object.assign(new Error('No other camera'), { name: 'NotFoundError' });
    const i = cameras.findIndex((d) => d.deviceId === currentId);
    const next = cameras[(i + 1) % cameras.length];
    return open({ deviceId: { exact: next.deviceId } });
  }

  async function publish(t) {
    await replaceTrack(t);
    track = t;
    const facing = facingOf(t);
    onTrack(t, { facing, mirror: shouldMirror(facing) });
    return facing;
  }

  async function switchCamera() {
    if (busy) return { ok: false, error: 'busy' };
    if (!track) return { ok: false, error: 'no camera' };
    busy = true;
    const old = track;
    const { deviceId: oldId, facingMode: oldFacing } = settingsOf(old);
    let fresh = null;
    try {
      old.stop(); // before opening the next one: many phones allow only one open camera
      try {
        fresh = await open({ facingMode: { exact: oldFacing === 'environment' ? 'user' : 'environment' } });
      } catch (e) {
        if (e?.name !== 'OverconstrainedError') throw e;
        fresh = await nextByDeviceId(oldId);
      }
      const facing = await publish(fresh);
      return { ok: true, track: fresh, facing, mirror: shouldMirror(facing) };
    } catch (e) {
      if (fresh) { try { fresh.stop(); } catch (_e) { /* already stopped */ } }
      const error = `${e?.name || 'Error'}: ${e?.message || e}`;
      try {
        const back = await open(oldId ? { deviceId: { exact: oldId } } : {});
        await publish(back);
        return { ok: false, error, restored: true };
      } catch (_e) {
        track = null;
        onTrack(null, { facing: undefined, mirror: false });
        return { ok: false, error, restored: false };
      }
    } finally {
      busy = false;
    }
  }

  // Re-check the camera count now and whenever devices change; cb(canSwitch).
  function watch(cb) {
    let live = true;
    const check = () => refresh().then(() => { if (live) cb(cameras.length >= 2); });
    mediaDevices.addEventListener?.('devicechange', check);
    check();
    return () => { live = false; mediaDevices.removeEventListener?.('devicechange', check); };
  }

  return {
    start(t) { track = t; },
    refresh,
    watch,
    switchCamera,
    get track() { return track; },
    get canSwitch() { return cameras.length >= 2; },
    get mirror() { return shouldMirror(facingOf(track)); },
    get busy() { return busy; },
  };
}
