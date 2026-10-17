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
