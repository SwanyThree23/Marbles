// Watch party helpers: turn whatever the host pastes into a YouTube video id, build the
// embed address, and translate host controls into player commands (YouTube's iframe
// postMessage API, so no third-party script runs on our page).
const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);
export const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com';

export function parseYoutubeId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (ID.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch (_e) { return null; }
  if (!/^https?:$/.test(u.protocol) || !HOSTS.has(u.hostname.toLowerCase())) return null;
  const candidate = u.hostname.endsWith('youtu.be')
    ? u.pathname.split('/')[1]
    : u.pathname === '/watch' ? u.searchParams.get('v') : (u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/) || [])[1];
  return candidate && ID.test(candidate) ? candidate : null;
}

export function embedUrl(id) {
  if (!ID.test(id || '')) throw new Error('not a YouTube video id');
  const q = new URLSearchParams({ enablejsapi: '1', autoplay: '1', mute: '1', playsinline: '1', rel: '0' });
  return `${PLAYER_ORIGIN}/embed/${id}?${q}`;
}

const cmd = (func, args = []) => ({ event: 'command', func, args });
export function playerCommand(action) {
  if (action === 'play') return [cmd('playVideo')];
  if (action === 'pause') return [cmd('pauseVideo')];
  if (action === 'restart') return [cmd('seekTo', [0, true]), cmd('playVideo')];
  return [];
}

// what a viewer's player does when the host acts at `position`
export function commandsFor(action, position) {
  const at = cmd('seekTo', [action === 'restart' ? 0 : position, true]);
  if (action === 'pause') return [cmd('pauseVideo'), at];
  if (action === 'play' || action === 'restart') return [at, cmd('playVideo')];
  if (action === 'seek') return [at];
  return [];
}

// ---- keeping everyone at the same second ----
// The room clock: the video is at `position` as of `at`, and moves on while playing.
export function createClock(now = () => Date.now()) {
  let s = { position: 0, playing: false, at: now() };
  return {
    set({ position, playing }) { s = { position: Number(position) || 0, playing: !!playing, at: now() }; },
    now() { return { position: s.playing ? s.position + (now() - s.at) / 1000 : s.position, playing: s.playing }; },
  };
}

// YouTube player states (from its embed API): -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
const DRIFT_SECONDS = 1.5;
// What to send a viewer's player so it matches the room. Small drift is left alone (constant
// seeking would stutter); buffering is given a moment.
export function correction(room, player) {
  if (player?.playerState === undefined || player.currentTime === undefined) return [];
  const out = [];
  const off = Math.abs(player.currentTime - room.position) > DRIFT_SECONDS;
  if (room.playing) {
    if (player.playerState === 3) return [];
    if (player.playerState === 1) return off ? [cmd('seekTo', [room.position, true])] : [];
    if (off) out.push(cmd('seekTo', [room.position, true]));
    out.push(cmd('playVideo'));
    return out;
  }
  if (player.playerState === 1) out.push(cmd('pauseVideo'));
  if (off) out.push(cmd('seekTo', [room.position, true]));
  return out;
}

// the player answers only after it is told someone is listening
export const LISTEN = JSON.stringify({ event: 'listening', id: 'km-watch-party', channel: 'widget' });
export function readPlayerMessage(data) {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data);
    return m && typeof m.event === 'string' ? { event: m.event, info: m.info } : null;
  } catch (_e) { return null; }
}
export function playerError(code) {
  if (code === 101 || code === 150) return "This video's owner doesn't allow it to be played on other sites. Try another video.";
  if (code === 100) return 'This video was removed or is private.';
  if (code === 2) return "That link doesn't point to a playable video.";
  return "This video can't be played here. Try another one.";
}
