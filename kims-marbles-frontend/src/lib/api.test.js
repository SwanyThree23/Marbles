// The session keeper. fetch is faked; tokens are real-shaped JWTs with real expiry claims.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as api from './api.js';

const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwtExpiringIn = (seconds, sub = 'u1') => `${b64({ alg: 'HS256' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + seconds })}.sig`;
const json = (status, body) => Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

let calls;
function server(handler) {
  calls = [];
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const path = String(url).replace(api.API_URL, '');
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, auth: opts.headers?.Authorization, body });
    return handler(path, { auth: opts.headers?.Authorization, body });
  });
}
function signIn(access = jwtExpiringIn(900), refresh = 'r0', user = { id: 'u1', handle: 'Joyce' }) {
  api.setSession({ user, accessToken: access, refreshToken: refresh });
}

beforeEach(() => { api.clearSession(); vi.restoreAllMocks(); });

describe('requests', () => {
  test('sends the bearer token and JSON; returns parsed JSON', async () => {
    signIn('tok-ok' + jwtExpiringIn(900).slice(6));
    server(() => json(200, { hello: 'world' }));
    expect(await api.apiFetch('/api/thing', { method: 'POST', body: JSON.stringify({ a: 1 }) })).toEqual({ hello: 'world' });
    expect(calls[0].auth).toMatch(/^Bearer /);
    expect(calls[0].body).toEqual({ a: 1 });
  });

  test('a server error becomes an Error carrying the server message and status', async () => {
    server(() => json(400, { error: 'name is required' }));
    await expect(api.apiFetch('/api/x')).rejects.toMatchObject({ message: 'name is required', status: 400 });
  });

  test('a network failure is an Error with status 0 and a human message', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(api.apiFetch('/api/x')).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/reach the server/i) });
  });

  test('204 returns null', async () => {
    server(() => json(204));
    expect(await api.apiFetch('/api/x', { method: 'DELETE' })).toBe(null);
  });
});

describe('keeping the session alive', () => {
  test('a token about to expire is refreshed BEFORE the request, and the rotated refresh token is stored', async () => {
    signIn(jwtExpiringIn(20), 'r0');
    const fresh = jwtExpiringIn(900);
    server((path) => (path === '/api/auth/refresh' ? json(200, { user: { id: 'u1', handle: 'Joyce' }, accessToken: fresh, refreshToken: 'r1' }) : json(200, { ok: 1 })));
    await api.apiFetch('/api/feed');
    expect(calls.map((c) => c.path)).toEqual(['/api/auth/refresh', '/api/feed']);
    expect(calls[0].body).toEqual({ refreshToken: 'r0' });
    expect(calls[1].auth).toBe(`Bearer ${fresh}`);
    expect(localStorage.getItem('kmRefreshToken')).toBe('r1');
  });

  test('a 401 triggers one refresh and one retry', async () => {
    signIn(jwtExpiringIn(900), 'r0');
    const fresh = jwtExpiringIn(1800);            // must differ from the token being replaced
    let n = 0;
    server((path, { auth }) => {
      if (path === '/api/auth/refresh') return json(200, { user: { id: 'u1' }, accessToken: fresh, refreshToken: 'r1' });
      n++;
      return auth === `Bearer ${fresh}` ? json(200, { ok: true }) : json(401, { error: 'Please log in' });
    });
    expect(await api.apiFetch('/api/me')).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  test('a 401 after the retry gives up instead of looping', async () => {
    signIn(jwtExpiringIn(900), 'r0');
    server((path) => (path === '/api/auth/refresh' ? json(200, { user: { id: 'u1' }, accessToken: jwtExpiringIn(900), refreshToken: 'r1' }) : json(401, { error: 'nope' })));
    await expect(api.apiFetch('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(calls.filter((c) => c.path === '/api/me')).toHaveLength(2);
  });

  test('simultaneous requests share ONE refresh', async () => {
    signIn(jwtExpiringIn(10), 'r0');
    server((path) => (path === '/api/auth/refresh'
      ? new Promise((r) => setTimeout(() => r(json(200, { user: { id: 'u1' }, accessToken: jwtExpiringIn(900), refreshToken: 'r1' })), 20)).then((x) => x)
      : json(200, {})));
    await Promise.all([api.apiFetch('/a'), api.apiFetch('/b'), api.apiFetch('/c')]);
    expect(calls.filter((c) => c.path === '/api/auth/refresh')).toHaveLength(1);
  });

  test('the session ends ONLY when the server rejects the refresh token', async () => {
    signIn(jwtExpiringIn(5), 'r0');
    const ended = vi.fn();
    const off = api.onSessionEnded(ended);
    server((path) => (path === '/api/auth/refresh' ? json(401, { error: 'Your session has ended' }) : json(200, {})));
    await expect(api.apiFetch('/api/me')).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(api.getCurrentUser()).toBe(null);
    expect(localStorage.getItem('kmRefreshToken')).toBe(null);
    off();
  });

  test('a network failure or a 5xx during refresh never logs anyone out', async () => {
    const ended = vi.fn();
    const off = api.onSessionEnded(ended);
    for (const failure of [() => Promise.reject(new TypeError('offline')), () => json(503, { error: 'down' })]) {
      signIn(jwtExpiringIn(5), 'r0');
      globalThis.fetch = vi.fn((url) => (String(url).endsWith('/api/auth/refresh') ? failure() : json(200, {})));
      await api.apiFetch('/api/feed').catch(() => {});
      expect(api.getCurrentUser()).not.toBe(null);
      expect(localStorage.getItem('kmRefreshToken')).toBe('r0');
    }
    expect(ended).not.toHaveBeenCalled();
    off();
  });

  test('a refresh that finishes after the user switched accounts is discarded', async () => {
    signIn(jwtExpiringIn(5), 'r-alice', { id: 'alice', handle: 'Alice' });
    let release;
    server((path) => (path === '/api/auth/refresh'
      ? new Promise((r) => { release = () => r(json(200, { user: { id: 'alice' }, accessToken: jwtExpiringIn(900, 'alice'), refreshToken: 'r-alice-2' })); })
      : json(200, {})));
    const pending = api.getFreshToken();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const bobToken = jwtExpiringIn(900, 'bob');
    signIn(bobToken, 'r-bob', { id: 'bob', handle: 'Bob' });
    release();
    await pending.catch(() => {});
    expect(api.getCurrentUser().id).toBe('bob');
    expect(localStorage.getItem('kmRefreshToken')).toBe('r-bob');
    expect(await api.getFreshToken()).toBe(bobToken);
  });

  test('anonymous requests carry no token and never refresh', async () => {
    server(() => json(200, []));
    await api.apiFetch('/api/feed');
    expect(calls).toHaveLength(1);
    expect(calls[0].auth).toBeUndefined();
  });
});

describe('the session survives a reload', () => {
  test('setSession persists; loadSession restores the user and tokens', () => {
    signIn(jwtExpiringIn(900), 'r0', { id: 'u9', handle: 'Saved' });
    api.forgetInMemory();
    api.loadSession();
    expect(api.getCurrentUser()).toEqual({ id: 'u9', handle: 'Saved' });
  });
});

describe('API_URL', () => {
  test('an EMPTY VITE_API_URL means same origin (never localhost)', () => {
    expect(api.resolveApiUrl('')).toBe('');
    expect(api.resolveApiUrl(undefined)).toBe('http://localhost:4100');
    expect(api.resolveApiUrl('https://api.example.com/')).toBe('https://api.example.com');
  });
});
