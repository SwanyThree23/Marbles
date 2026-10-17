// Reporting, the moderators' queue, and the watch party.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const calls = [];
let routes = {};
vi.mock('../lib/api', async (orig) => {
  const real = await orig();
  return {
    ...real,
    apiFetch: vi.fn(async (path, opts = {}) => {
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ method, path, body });
      const h = routes[`${method} ${path.split('?')[0]}`];
      if (!h) throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 500 });
      return typeof h === 'function' ? h(body, path) : h;
    }),
  };
});
let me = { id: 'u1', handle: 'Kim', is_admin: false };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: me, logout: vi.fn() }) }));
vi.mock('../lib/userSocket', () => ({ onNotification: () => () => {} }));

import ReportButton from '../components/ReportButton';
import ModerationQueue from './ModerationQueue';
import Layout from '../components/Layout';
import WatchParty from '../components/WatchParty';
import { ToastProvider } from '../components/Toast';

const wrap = (el) => render(<ToastProvider><MemoryRouter>{el}</MemoryRouter></ToastProvider>);
beforeEach(() => { calls.length = 0; routes = {}; me = { id: 'u1', handle: 'Kim', is_admin: false }; });

describe('reporting', () => {
  test('a report sends the type, id, label, reason and details, then thanks the person', async () => {
    const user = userEvent.setup();
    routes['POST /api/reports'] = (b) => ({ id: 'r1', ...b });
    wrap(<ReportButton targetType="listing" targetId="l1" targetLabel="Fake Lutz (Bob)" />);
    await user.click(screen.getByRole('button', { name: '⚑ Report' }));
    await user.selectOptions(screen.getByLabelText(/What's wrong/), 'Scam or fraud');
    await user.type(screen.getByLabelText('Details (optional)'), 'photos stolen from eBay');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/A moderator will review it/)).toBeTruthy();
    expect(calls.at(-1).body).toEqual({ targetType: 'listing', targetId: 'l1', targetLabel: 'Fake Lutz (Bob)', reason: 'Scam or fraud', details: 'photos stolen from eBay' });
  });

  test('a refusal is shown and the form stays open', async () => {
    const user = userEvent.setup();
    routes['POST /api/reports'] = () => { throw Object.assign(new Error('Too many requests. Try again in a minute.'), { status: 429 }); };
    wrap(<ReportButton targetType="post" targetId="p1" />);
    await user.click(screen.getByRole('button', { name: '⚑ Report' }));
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Too many requests/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send report' })).toBeTruthy();
  });
});

describe('moderation queue', () => {
  const open = [
    { id: 'r1', target_type: 'post', target_id: 'p1', target_label: 'Bob: buy followers', reason: 'Spam', details: '', reporter_handle: 'Ann', status: 'open', created_at: '2026-10-01T00:00:00Z' },
    { id: 'r2', target_type: 'user', target_id: 'u9', target_label: 'Troll', reason: 'Harassment or hate', details: 'DMs', reporter_handle: 'Cy', status: 'open', created_at: '2026-10-01T00:00:00Z' },
  ];

  test('not for regular users, and their browser never asks for the reports', async () => {
    wrap(<ModerationQueue />);
    expect(screen.getByText('This page is for moderators.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  test('an admin removes a reported post: the post is deleted, then the report is closed as actioned', async () => {
    const user = userEvent.setup();
    me = { ...me, is_admin: true };
    routes['GET /api/reports'] = open;
    routes['DELETE /api/feed/p1'] = () => null;
    routes['PATCH /api/reports/r1'] = (b) => ({ id: 'r1', ...b });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    wrap(<ModerationQueue />);
    const row = (await screen.findByText('“Bob: buy followers”')).closest('.report-row');
    await user.click(within(row).getByRole('button', { name: 'Remove post' }));
    await waitFor(() => expect(screen.queryByText('“Bob: buy followers”')).toBeNull());
    expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body || '')}`))
      .toEqual(['DELETE /api/feed/p1 ""', 'PATCH /api/reports/r1 {"status":"actioned"}']);
    confirm.mockRestore();
  });

  test('a person cannot be "removed" from here; dismissing closes the report without touching anything', async () => {
    const user = userEvent.setup();
    me = { ...me, is_admin: true };
    routes['GET /api/reports'] = open;
    routes['PATCH /api/reports/r2'] = (b) => b;
    wrap(<ModerationQueue />);
    const row = (await screen.findByText('“Troll”')).closest('.report-row');
    expect(within(row).queryByRole('button', { name: /Remove/ })).toBeNull();
    await user.click(within(row).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{ method: 'PATCH', path: '/api/reports/r2', body: { status: 'dismissed' } }]);
  });

  test('the Reports link is in the nav for admins only', () => {
    routes['GET /api/notifications'] = [];
    const { unmount } = wrap(<Layout />);
    expect(screen.queryByRole('link', { name: '🛡️ Reports' })).toBeNull();
    unmount();
    me = { ...me, is_admin: true };
    wrap(<Layout />);
    expect(screen.getByRole('link', { name: '🛡️ Reports' }).getAttribute('href')).toBe('/moderation');
  });
});

describe('watch party', () => {
  const room = { id: 'room-1', host_id: 'u1' };
  const sock = () => {
    const l = new Map(); const sent = [];
    return { sent, on(e, f) { l.set(e, f); }, off(e) { l.delete(e); }, emit(e, p) { sent.push({ e, p }); }, push(e, d) { act(() => l.get(e)?.(d)); } };
  };

  test('joining a room that is already watching shows the video, privacy-enhanced and muted', async () => {
    routes['GET /api/rooms/room-1/watchparty'] = { state: { youtube_id: 'dQw4w9WgXcQ', title: 'Marble run' }, queue: [] };
    wrap(<WatchParty room={room} isHost={false} socket={sock()} panelOpen={false} />);
    const frame = await screen.findByTitle('Watch party: Marble run');
    expect(frame.getAttribute('src')).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?.*mute=1/);
  });

  test('the host plays a pasted link for everyone: saved on the server and sent to the room', async () => {
    const user = userEvent.setup();
    routes['GET /api/rooms/room-1/watchparty'] = { state: null, queue: [] };
    routes['POST /api/rooms/room-1/watchparty/load'] = (b) => b;
    const s = sock();
    wrap(<WatchParty room={room} isHost socket={s} panelOpen />);
    await user.type(screen.getByLabelText('YouTube link'), 'https://youtu.be/dQw4w9WgXcQ?si=x');
    await user.type(screen.getByLabelText('Video title (optional)'), 'Swirls 101');
    await user.click(screen.getByRole('button', { name: 'Play for everyone' }));
    await screen.findByTitle('Watch party: Swirls 101');
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ youtubeId: 'dQw4w9WgXcQ', title: 'Swirls 101' });
    expect(s.sent).toEqual([{ e: 'watchparty:load', p: { roomId: 'room-1', youtubeId: 'dQw4w9WgXcQ', title: 'Swirls 101' } }]);
  });

  test('a viewer gets the host\'s video and controls; the controls reach the player as YouTube commands', async () => {
    routes['GET /api/rooms/room-1/watchparty'] = { state: null, queue: [] };
    const s = sock();
    wrap(<WatchParty room={room} isHost={false} socket={s} panelOpen={false} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    s.push('watchparty:load', { roomId: 'other-room', youtubeId: 'aaaaaaaaaaa', title: 'no' });
    expect(screen.queryByTitle(/Watch party:/)).toBeNull();
    s.push('watchparty:load', { roomId: 'room-1', youtubeId: 'dQw4w9WgXcQ', title: 'Live' });
    const frame = await screen.findByTitle('Watch party: Live');
    const post = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage: post } });
    s.push('watchparty:control', { roomId: 'room-1', action: 'restart' });
    expect(post.mock.calls.map(([m, origin]) => [JSON.parse(m).func, origin])).toEqual([['seekTo', 'https://www.youtube-nocookie.com'], ['playVideo', 'https://www.youtube-nocookie.com']]);
    expect(screen.queryByTitle('Pause for everyone')).toBeNull();
  });

  test('a viewer suggests a video to the queue; a bad link is explained instead', async () => {
    const user = userEvent.setup();
    let queue = [];
    routes['GET /api/rooms/room-1/watchparty'] = () => ({ state: null, queue });
    routes['POST /api/rooms/room-1/watchparty/queue'] = (b) => { queue = [{ id: 'q1', youtube_id: b.youtubeId, title: b.title }]; return queue[0]; };
    wrap(<WatchParty room={room} isHost={false} socket={sock()} panelOpen />);
    await user.type(screen.getByLabelText('YouTube link'), 'https://evil.com/watch?v=dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: 'Suggest to the host' }));
    expect(await screen.findByText(/Paste a YouTube link/)).toBeTruthy();
    await user.clear(screen.getByLabelText('YouTube link'));
    await user.type(screen.getByLabelText('YouTube link'), 'dQw4w9WgXcQ');
    await user.click(screen.getByRole('button', { name: 'Suggest to the host' }));
    expect(await screen.findByText('dQw4w9WgXcQ')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
  });
});
