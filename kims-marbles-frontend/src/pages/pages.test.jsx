// Marketplace and Me, with the network faked at apiFetch (the real contract is covered by
// the real-backend and real-browser suites).
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

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
      const key = `${method} ${path.split('?')[0]}`;
      const h = routes[key];
      if (!h) throw Object.assign(new Error(`unexpected ${key}`), { status: 500 });
      return typeof h === 'function' ? h(body, path) : h;
    }),
  };
});
const devices = { list: [], fns: new Set() };
vi.mock('../lib/userSocket', () => ({
  onDevices: (fn) => { devices.fns.add(fn); fn(devices.list); return () => devices.fns.delete(fn); },
  getDeviceId: () => 'dev-me',
  emitSetting: vi.fn(), onRemoteSetting: () => () => {}, startUserSocket: vi.fn(), stopUserSocket: vi.fn(), onNotification: () => () => {},
}));
const logoutEverywhere = vi.fn(async () => {});
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', handle: 'Joyce' }, logoutEverywhere }) }));

import Marketplace from './Marketplace';
import Me from './Me';
import { ToastProvider } from '../components/Toast';
import * as theme from '../lib/theme';

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
const renderAt = (url, el) => render(
  <ToastProvider><MemoryRouter initialEntries={[url]}><Routes><Route path="*" element={<>{el}<Where /></>} /></Routes></MemoryRouter></ToastProvider>
);

beforeEach(() => {
  calls.length = 0;
  routes = {
    'GET /api/listings': [],
    'GET /api/battles/leaderboard': [],
    'GET /api/templates': [],
    'GET /api/collection': [],
  };
});

describe('Marketplace', () => {
  test('lists marbles from the server with prices in dollars and the seller', async () => {
    routes['GET /api/listings'] = [{ id: 'l1', name: 'Oxblood Swirl', category: 'Swirl', grade: 'mint', type: 'sale', price_cents: 8500, seller_handle: 'MarbleMike', description: '' }];
    renderAt('/market', <Marketplace />);
    expect(await screen.findByText('Oxblood Swirl')).toBeTruthy();
    expect(screen.getByText('$85.00')).toBeTruthy();
    expect(screen.getByText('MarbleMike')).toBeTruthy();
  });

  test('a junk price is refused instead of becoming a free listing', async () => {
    const user = userEvent.setup();
    renderAt('/market', <Marketplace />);
    await user.click(await screen.findByRole('button', { name: '＋ List a Marble' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Blue Swirl');
    await user.clear(screen.getByPlaceholderText('Price ($)'));
    await user.type(screen.getByPlaceholderText('Price ($)'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Publish Listing' }));
    expect(await screen.findByText(/Enter a price like 42 or 42.50/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/listings')).toBe(false);
  });

  test('publishing sends cents and the chosen fields, then shows the new listing', async () => {
    const user = userEvent.setup();
    routes['POST /api/listings'] = (b) => { routes['GET /api/listings'] = [{ id: 'n1', ...b, price_cents: b.priceCents, seller_handle: 'Joyce' }]; return { id: 'n1' }; };
    renderAt('/market', <Marketplace />);
    await user.click(await screen.findByRole('button', { name: '＋ List a Marble' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Blue Swirl');
    await user.clear(screen.getByPlaceholderText('Price ($)'));
    await user.type(screen.getByPlaceholderText('Price ($)'), '42.50');
    await user.click(screen.getByRole('button', { name: 'Publish Listing' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/listings')?.body).toMatchObject({ name: 'Blue Swirl', priceCents: 4250, type: 'sale', grade: 'mint', category: 'Swirl' }));
    expect(await screen.findByText('Blue Swirl')).toBeTruthy();
  });

  test('"Save as Template" saves the draft; /market?template=<id> opens the form pre-filled and drops the param', async () => {
    const user = userEvent.setup();
    routes['POST /api/templates'] = (b) => ({ id: 't1', ...b });
    renderAt('/market', <Marketplace />);
    await user.click(await screen.findByRole('button', { name: '＋ List a Marble' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Standard Swirl');
    await user.click(screen.getByRole('button', { name: '💾 Save as Template' }));
    expect(await screen.findByText('Template "Standard Swirl" saved')).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/templates' && c.method === 'POST').body).toMatchObject({ name: 'Standard Swirl', priceCents: 5000 });
  });

  test('a template link fills the form', async () => {
    routes['GET /api/templates'] = [{ id: 't9', name: 'Lutz Template', category: 'Vintage', grade: 'good', type: 'sale', price_cents: 1999, description: 'copper bands' }];
    renderAt('/market?template=t9', <Marketplace />);
    await waitFor(() => expect(screen.getByPlaceholderText('Name').value).toBe('Lutz Template'));
    expect(screen.getByPlaceholderText('Price ($)').value).toBe('19.99');
    expect(screen.getByPlaceholderText('Name').value).toBe('Lutz Template');
    expect(screen.getByPlaceholderText('Description').value).toBe('copper bands');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/market'));
  });

  test('a server error is shown as a sentence, not swallowed', async () => {
    routes['GET /api/listings'] = () => { throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { status: 0 }); };
    renderAt('/market', <Marketplace />);
    expect(await screen.findByText(/Can't reach the server/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('Me', () => {
  beforeEach(() => {
    theme.resetForTests();
    theme.initTheme(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    routes['GET /api/moderation'] = { enabled: false, words: [] };
    routes['GET /api/payments/status'] = { onboarded: false, chargesEnabled: false };
    routes['GET /api/achievements'] = [];
    routes['GET /api/auth/me'] = { id: 'u1', handle: 'Joyce', email: 'joyce@example.com', email_verified: true };
    devices.list = [];
  });

  test('email: confirmed shows a tick; unconfirmed offers to send the link again', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt('/me', <Me />);
    const card = (await screen.findByText('joyce@example.com')).closest('.settings-card');
    expect(within(card).getByText('✓ Confirmed')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Send confirmation email' })).toBeNull();
    unmount();
    routes['GET /api/auth/me'] = { id: 'u1', handle: 'Joyce', email: 'joyce@example.com', email_verified: false };
    routes['POST /api/auth/verify/resend'] = { ok: true, message: 'A new confirmation link is on its way to joyce@example.com.' };
    renderAt('/me', <Me />);
    await user.click(await screen.findByRole('button', { name: 'Send confirmation email' }));
    expect(await screen.findByText(/A new confirmation link is on its way/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send confirmation email' }).disabled).toBe(true);
  });

  test('appearance: the pressed button follows the choice; choosing Dark applies it', async () => {
    const user = userEvent.setup();
    renderAt('/me', <Me />);
    const card = (await screen.findByText('Appearance')).closest('.settings-card');
    expect(within(card).getByRole('button', { name: '🖥️ System' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(card).getByRole('button', { name: '🌙 Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(within(card).getByRole('button', { name: '🌙 Dark' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a theme change from another device updates the pressed button too', async () => {
    renderAt('/me', <Me />);
    const card = (await screen.findByText('Appearance')).closest('.settings-card');
    theme.applyRemoteChoice('dark');
    await waitFor(() => expect(within(card).getByRole('button', { name: '🌙 Dark' }).getAttribute('aria-pressed')).toBe('true'));
  });

  test('your devices: live list, this device marked', async () => {
    renderAt('/me', <Me />);
    const card = () => screen.getByText('Your devices').closest('.settings-card');
    expect(await screen.findByText(/Only this device/)).toBeTruthy();
    devices.list = [{ deviceId: 'dev-me', label: '💻 Desktop' }, { deviceId: 'dev-2', label: '📱 Mobile' }];
    devices.fns.forEach((fn) => fn(devices.list));
    await waitFor(() => expect(card().textContent).toMatch(/2 devices/));
    expect(card().textContent).toMatch(/this device/);
  });

  test('"Sign out of all devices" asks first and signs out only after the server confirms', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderAt('/me', <Me />);
    await user.click(await screen.findByRole('button', { name: 'Sign out of all devices' }));
    expect(logoutEverywhere).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out of all devices' }));
    expect(logoutEverywhere).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  test('chat moderation: saves the list to the server', async () => {
    const user = userEvent.setup();
    routes['PUT /api/moderation'] = (b) => b;
    renderAt('/me', <Me />);
    const card = (await screen.findByText('Live Chat Moderation')).closest('.settings-card');
    await user.click(within(card).getByLabelText(/Block messages containing/));
    await user.type(within(card).getByPlaceholderText(/One word or phrase/), 'scammer{enter}spam');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(await within(card).findByText('✓ Saved')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT').body).toEqual({ enabled: true, words: ['scammer', 'spam'] });
  });
});
