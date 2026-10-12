# Camera switching (front / back) — drop-in for the React live room

`src/cameraSwitch.js` is the last preview feature missing from the React app. It is built and
tested here as a standalone module because this repo does not yet contain the full
`kims-marbles-frontend` (no `LiveRoom.jsx` / `mediaClient.js`). Once the app is in the repo,
copy it to `kims-marbles-frontend/src/lib/cameraSwitch.js` (and the test next to it) and wire it
in as below.

## What it does

- Tries `facingMode: { exact: 'environment' | 'user' }` first (the right call on real phones).
- On `OverconstrainedError` (desktops, Chromium fake cameras: no `facingMode`) cycles to the next
  `videoinput` by `deviceId`, wrapping around. Any other error (permission, camera busy) is not
  treated as "try the next camera".
- Stops the old video track **before** opening the new one (many Android phones can hold only
  one camera open).
- Publishes with `replaceTrack`: no renegotiation, viewers see no drop, audio is never touched
  (it only ever calls `getUserMedia` with `audio: false`).
- Mirror flag for the **local preview only**: front camera (or a camera that reports no facing,
  i.e. a laptop webcam) is mirrored, the back camera never is. The outgoing track is never
  mirrored.
- `canSwitch` is true only with 2+ cameras that have ids (ids are blank before permission), and
  `watch()` re-checks on `devicechange`.
- If the switch fails, the previous camera is reopened and republished (`restored: true`). If
  even that fails, `onTrack(null)` and `restored: false` so the UI can say the camera is off.
- A second tap while switching returns `{ ok: false, error: 'busy' }`.

## Wiring into LiveRoom (mediasoup-client)

mediasoup-client's `Producer.replaceTrack` takes an **object**, unlike `RTCRtpSender.replaceTrack`:

```jsx
import { createCameraSwitcher } from './lib/cameraSwitch';

// after the camera producer exists (and again after the reconnect rebuild):
const switcher = createCameraSwitcher({
  mediaDevices: navigator.mediaDevices,
  replaceTrack: (track) => videoProducerRef.current.replaceTrack({ track }),
  onTrack: (track, { mirror }) => {
    localStreamRef.current = track ? new MediaStream([track, ...localStreamRef.current.getAudioTracks()]) : null;
    localVideoRef.current.srcObject = localStreamRef.current;
    setMirrorPreview(mirror);             // className -> transform: scaleX(-1) on the local <video> only
  },
});
switcher.start(cameraTrack);
useEffect(() => switcher.watch(setCanSwitch), [switcher]);   // show 🔄 only when canSwitch

async function onSwitchClick() {
  const r = await switcher.switchCamera();
  if (!r.ok && r.error !== 'busy') toast(r.restored ? "Couldn't switch camera" : 'Camera is off — tap 📷 to retry');
}
```

The reconnect rebuild republishes "the same camera": it must use `switcher.track`, not the
track captured at first join, or a rebuild after a switch flips back to the old camera.

## Tests

```bash
npm install
npm test               # 15 unit tests (fake mediaDevices)
npm run test:browser   # 5 tests in real Chromium, real WebRTC, fake cameras
```

Unit: `facingMode` success path; `OverconstrainedError` -> `deviceId` fallback and wrap-around;
no fallback on other errors; stop-before-open order (the fake refuses two open cameras, like
Android); mirroring rules; button hidden with one camera and before permission; `devicechange`;
restore when the new camera fails, when `replaceTrack` rejects, and when the restore itself
fails; busy guard. Mutation-checked: stop-after-open, fallback-on-any-error, no restore,
mirroring the back camera, counting cameras before permission and no busy guard were each
caught.

Real browser (host -> viewer over a real `RTCPeerConnection`, the module driving the real
`RTCRtpSender`): after a switch the sender is on a **different** camera, its track is live,
the viewer's track stays live and `framesDecoded` keeps rising, there is no renegotiation,
audio is untouched; switching back returns to the first camera; the preview mirror is set;
one camera -> no switch offered. A permanent control (`?break=replace`) shows the viewer's
video stalls without `replaceTrack`, and breaking `replaceTrack` inside the module fails the
main test ("the sender is still on the old camera").

### Chromium fake-camera quirk (found by these tests)

With `--use-fake-device-for-media-stream=device-count=2`, the switch "succeeds" but viewers
see a frozen picture: Chromium's `fake_device_1` opens and draws frames locally but **never
encodes** (`framesEncoded` stays 0, even as the first track on a fresh connection). Devices 0
and 2 encode fine. The tests therefore launch `device-count=3` and hide `fake_device_1` from
the switcher (`e2e/harness.html`). Measured on Chromium 141 (Playwright build 1194).

### Not covered here

- **Real `facingMode`** on an iPhone (Safari) and an Android phone (Chrome). No emulator covers
  it; it is a manual check on the deployment checklist:
  1. Host goes live on the phone, a viewer joins from a laptop.
  2. Tap 🔄: the viewer sees the back camera within ~1 s with no black frame and no audio gap.
  3. The host's preview is mirrored on the front camera only.
  4. Tap 🔄 again: back to the front camera.
  5. Deny camera permission mid-stream (or open the camera in another app), tap 🔄: the
     previous camera stays live or a "camera is off" notice appears; never a silent black tile.
- Firefox / WebKit (Playwright exposes one fake camera there).
- A camera that opens but produces no encodable frames (like `fake_device_1`) is reported as a
  successful switch; the module cannot see encoder output. Not seen on real phones.
- Integration into `LiveRoom.jsx` itself, the full-app real-browser suite, and the reconnect
  rebuild with a switched camera: blocked until the full frontend is in this repo.
