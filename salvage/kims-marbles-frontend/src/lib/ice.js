// ice.js — the ICE (STUN/TURN) servers the media transports should use.
//
// Without a TURN relay, anyone behind a strict NAT or a network that blocks UDP
// simply cannot reach the SFU. The server issues short-lived TURN credentials
// (GET /api/rtc/ice-servers); we cache them for 80% of their lifetime so a long
// stream always has valid ones for its next (re)connect.
//
// Failure is never fatal: with no ICE servers the browser still tries a direct
// connection, which works for most people.
import { apiFetch, getCurrentUser } from './api';

let cache = null;      // { userId, iceServers, until }
let inflight = null;   // shared by simultaneous callers

// localStorage.kmIceTransportPolicy = 'relay' forces relayed-only media. Used for
// support ("does it work through TURN?") and by the browser tests.
const transportPolicy = () => (localStorage.getItem('kmIceTransportPolicy') === 'relay' ? 'relay' : 'all');

export async function fetchIceConfig() {
  const iceTransportPolicy = transportPolicy();
  const userId = getCurrentUser()?.id ?? null;
  if (cache && cache.userId === userId && cache.until > Date.now()) {
    return { iceServers: cache.iceServers, iceTransportPolicy };
  }
  if (!inflight) {
    inflight = apiFetch('/api/rtc/ice-servers')
      .then((r) => {
        cache = { userId, iceServers: r.iceServers || [], until: Date.now() + (r.ttl || 3600) * 1000 * 0.8 };
        return cache;
      })
      .catch(() => null) // not cached, so the next join tries again
      .finally(() => { inflight = null; });
  }
  const got = await inflight;
  return { iceServers: got ? got.iceServers : [], iceTransportPolicy };
}

export function resetIceCache() { cache = null; inflight = null; }
