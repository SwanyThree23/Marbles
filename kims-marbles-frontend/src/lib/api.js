// The one fetch wrapper every page uses, and the keeper of the login.
//
// Access tokens last 15 minutes. A token that is about to expire is refreshed BEFORE the
// request (public routes like the feed would otherwise quietly treat you as logged out), a
// 401 gets one refresh and one retry, and simultaneous requests share one refresh. The
// session ends only when the server REJECTS the refresh token: a flaky network or a 5xx
// never logs anyone out. The server rotates refresh tokens, so each new one is stored. A
// refresh that finishes after the user switched accounts is thrown away (`epoch`).

export const resolveApiUrl = (v) => (v === undefined ? 'http://localhost:4100' : v.replace(/\/$/, ''));
// VITE_API_URL= (empty) means "same origin": the app calls /api on whatever domain served it.
export const API_URL = resolveApiUrl(import.meta.env.VITE_API_URL);

const KEYS = { user: 'kmUser', access: 'kmAccessToken', refresh: 'kmRefreshToken' };
const EARLY_SECONDS = 60; // refresh this long before the access token expires

let session = null; // { user, accessToken, refreshToken }
let epoch = 0;      // bumps on every sign-in / sign-out
let refreshing = null; // { epoch, promise }
const endedListeners = new Set();
const changeListeners = new Set();

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch (_e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_e) { /* storage blocked */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch (_e) { /* storage blocked */ } },
};

function emitChange() { changeListeners.forEach((fn) => fn(session?.user || null)); }

export function setSession({ user, accessToken, refreshToken }) {
  epoch += 1;
  session = { user, accessToken, refreshToken };
  store.set(KEYS.user, JSON.stringify(user));
  store.set(KEYS.access, accessToken);
  store.set(KEYS.refresh, refreshToken);
  emitChange();
}

export function clearSession() {
  epoch += 1;
  session = null;
  Object.values(KEYS).forEach(store.del);
  emitChange();
}

export function loadSession() {
  const refreshToken = store.get(KEYS.refresh);
  let user = null;
  try { user = JSON.parse(store.get(KEYS.user) || 'null'); } catch (_e) { user = null; }
  session = refreshToken && user ? { user, accessToken: store.get(KEYS.access) || '', refreshToken } : null;
  return session?.user || null;
}
export const forgetInMemory = () => { session = null; }; // tests: simulate a page reload

export const getCurrentUser = () => session?.user || null;
export const getRefreshToken = () => session?.refreshToken || null;
export function onSessionEnded(fn) { endedListeners.add(fn); return () => endedListeners.delete(fn); }
export function onSessionChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }

function expiresSoon(token) {
  if (!token) return true;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(part));
    return typeof exp === 'number' && exp - EARLY_SECONDS <= Date.now() / 1000;
  } catch (_e) {
    return false; // not a JWT we can read: let the server decide
  }
}

async function rawFetch(path, opts = {}) {
  try {
    return await fetch(`${API_URL}${path}`, opts);
  } catch (_e) {
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
  }
}

async function doRefresh(myEpoch, refreshToken) {
  const res = await rawFetch('/api/auth/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (myEpoch !== epoch) return null;             // the user switched accounts meanwhile: discard
  if (res.status === 401 || res.status === 400) {
    clearSession();
    endedListeners.forEach((fn) => fn());
    throw new ApiError(data.error || 'Your session has ended. Please log in again.', 401);
  }
  if (!res.ok) throw new ApiError(data.error || 'The server had a problem. Try again in a moment.', res.status);
  setSession(data);
  return data.accessToken;
}

// Refreshes now (single-flight per login).
export function refreshNow() {
  if (!session) return Promise.resolve(null);
  if (!refreshing || refreshing.epoch !== epoch) {
    const p = doRefresh(epoch, session.refreshToken).finally(() => { if (refreshing?.promise === p) refreshing = null; });
    refreshing = { epoch, promise: p };
  }
  return refreshing.promise;
}

// A usable access token (refreshed first if it is about to expire), or null when logged out.
// Only a REJECTED refresh throws; a network/5xx failure falls back to the current token.
export async function getFreshToken() {
  if (!session) return null;
  if (expiresSoon(session.accessToken)) {
    try {
      await refreshNow();
    } catch (err) {
      if (err.status === 401) throw err;
    }
  }
  return session ? session.accessToken : null;
}

export async function apiFetch(path, opts = {}, retried = false) {
  const token = await getFreshToken();
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await rawFetch(path, { ...opts, headers });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data?.suspended) {
    // a moderator suspended this account: no refresh can help, sign out here and say why
    clearSession();
    endedListeners.forEach((fn) => fn('suspended'));
    throw new ApiError(data.error, 401, data);
  }
  if (res.status === 401 && token && !retried) {
    await refreshNow();
    return apiFetch(path, opts, true);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  return data;
}
