// Forgot password, the reset link page (logged in or out), and suspending from the queue.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const calls = [];
let routes = {};
vi.mock('./../lib/api', async (orig) => {
  const real = await orig();
  return {
    ...real,
    clearSession: vi.fn(),
    apiFetch: vi.fn(async (path, opts = {}) => {
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ method, path, body });
      const h = routes[`${method} ${path.split('?')[0]}`];
      if (!h) throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 500 });
      return h(body);
    }),
  };
});
let auth = { isAuthed: false, user: null };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ ...auth, login: vi.fn(), register: vi.fn(), logout: vi.fn(), notice: null }) }));
vi.mock('../lib/userSocket', () => ({ onNotification: () => () => {} }));

import { Gate } from '../App';
import ModerationQueue from './ModerationQueue';
import * as api from '../lib/api';
import { ToastProvider } from '../components/Toast';

const at = (url, el = <Gate />) => render(<ToastProvider><MemoryRouter initialEntries={[url]}>{el}</MemoryRouter></ToastProvider>);
beforeEach(() => { calls.length = 0; routes = {}; auth = { isAuthed: false, user: null }; api.clearSession.mockClear(); });

describe('forgot password', () => {
  test('from the login screen: sends the email and shows the server\'s neutral answer', async () => {
    const user = userEvent.setup();
    routes['POST /api/auth/forgot'] = () => ({ ok: true, message: 'If an account uses that email, a reset link is on its way.' });
    at('/market');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Email'), 'kim@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/a reset link is on its way/)).toBeTruthy();
    expect(calls[0]).toEqual({ method: 'POST', path: '/api/auth/forgot', body: { email: 'kim@example.com' } });
  });

  test('when email is not set up, the person is told instead of waiting for an email that never comes', async () => {
    const user = userEvent.setup();
    routes['POST /api/auth/forgot'] = () => { throw Object.assign(new Error('Password reset by email is not set up yet. Please contact support.'), { status: 503 }); };
    at('/');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await user.type(screen.getByLabelText('Email'), 'kim@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/not set up yet/)).toBeTruthy();
  });
});

describe('the reset link', () => {
  test('opens while logged out; mismatched passwords are caught before sending', async () => {
    const user = userEvent.setup();
    at('/reset/tok123');
    await user.type(await screen.findByLabelText('New password'), 'longenough1');
    await user.type(screen.getByLabelText('New password again'), 'longenough2');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(screen.getByText("The two passwords don't match")).toBeTruthy();
    expect(calls).toEqual([]);
  });

  test('saves the new password with the token from the link, then signs this device out', async () => {
    const user = userEvent.setup();
    routes['POST /api/auth/reset'] = () => null;
    auth = { isAuthed: true, user: { id: 'u1', handle: 'Kim' } };
    at('/reset/tok123');
    await user.type(await screen.findByLabelText('New password'), 'brand new pw');
    await user.type(screen.getByLabelText('New password again'), 'brand new pw');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText('Password changed')).toBeTruthy();
    expect(calls[0].body).toEqual({ token: 'tok123', password: 'brand new pw' });
    expect(api.clearSession).toHaveBeenCalled();
  });

  test('an expired link shows the server\'s message', async () => {
    const user = userEvent.setup();
    routes['POST /api/auth/reset'] = () => { throw Object.assign(new Error('This reset link is not valid or has expired'), { status: 400 }); };
    at('/reset/old');
    await user.type(await screen.findByLabelText('New password'), 'brand new pw');
    await user.type(screen.getByLabelText('New password again'), 'brand new pw');
    await user.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByText(/not valid or has expired/)).toBeTruthy();
  });
});

describe('suspending from the queue', () => {
  beforeEach(() => { auth = { isAuthed: true, user: { id: 'a1', handle: 'Mod', is_admin: true } }; });

  test('"Suspend the author" asks for a reason and suspends whoever owns the reported post', async () => {
    const user = userEvent.setup();
    routes['GET /api/reports'] = () => [{ id: 'r1', target_type: 'post', target_id: 'p1', target_label: 'spam post', reason: 'Spam', details: '', reporter_handle: 'Ann', status: 'open', created_at: '2026-10-01T00:00:00Z' }];
    routes['POST /api/reports/r1/ban-author'] = () => ({ user: { handle: 'Bob' } });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('repeat spammer');
    at('/moderation', <ModerationQueue />);
    const row = (await screen.findByText('“spam post”')).closest('.report-row');
    await user.click(within(row).getByRole('button', { name: 'Suspend the author' }));
    expect(await screen.findByText('Bob is suspended')).toBeTruthy();
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/reports/r1/ban-author', body: { reason: 'repeat spammer' } });
    prompt.mockRestore();
  });

  test('cancelling the reason prompt suspends nobody', async () => {
    const user = userEvent.setup();
    routes['GET /api/reports'] = () => [{ id: 'r1', target_type: 'listing', target_id: 'l1', target_label: 'x', reason: 'Scam', details: '', reporter_handle: 'Ann', status: 'open', created_at: '2026-10-01T00:00:00Z' }];
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);
    at('/moderation', <ModerationQueue />);
    await user.click(await screen.findByRole('button', { name: 'Suspend the seller' }));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    prompt.mockRestore();
  });

  test('the Suspended tab lists suspended people; Unsuspend lets them back in', async () => {
    const user = userEvent.setup();
    routes['GET /api/reports'] = () => [];
    routes['GET /api/users/banned'] = () => [{ id: 'u9', handle: 'Bob', banned_reason: 'spam', banned_by_handle: 'Mod', banned_at: '2026-10-02T00:00:00Z' }];
    routes['POST /api/users/u9/unban'] = () => ({ id: 'u9' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    at('/moderation', <ModerationQueue />);
    await user.click(await screen.findByRole('button', { name: 'Suspended' }));
    const row = (await screen.findByText('Bob')).closest('.banned-row');
    expect(row.textContent).toMatch(/spam.*by Mod/);
    await user.click(within(row).getByRole('button', { name: 'Unsuspend' }));
    await waitFor(() => expect(screen.queryByText('Bob')).toBeNull());
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/users/u9/unban', body: undefined });
    confirm.mockRestore();
  });
});
