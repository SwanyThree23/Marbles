// Learn, Dashboard, Feed, Panels and the live room (chat, moderation, tips, host commands,
// two-device handling), with the network faked at apiFetch and a scripted socket.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QUIZ } from '../lib/learnData';

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

// a scripted socket shared by the user-socket mock
const sock = {
  connected: true, l: new Map(), sent: [], acks: {},
  on(ev, fn) { if (!this.l.has(ev)) this.l.set(ev, new Set()); this.l.get(ev).add(fn); },
  off(ev, fn) { this.l.get(ev)?.delete(fn); },
  emit(ev, payload, ack) { this.sent.push({ ev, payload }); if (ack && this.acks[ev]) ack(this.acks[ev](payload)); },
  push(ev, data) { act(() => { this.l.get(ev)?.forEach((fn) => fn(data)); }); },
  reset() { this.l = new Map(); this.sent = []; this.acks = {}; },
};
vi.mock('../lib/userSocket', () => ({
  startUserSocket: vi.fn(), getUserSocket: () => sock, onNotification: () => () => {},
  onDevices: () => () => {}, getDeviceId: () => 'd', emitSetting: vi.fn(), onRemoteSetting: () => () => {}, stopUserSocket: vi.fn(),
}));
vi.mock('../lib/ice', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('mediasoup-client', () => ({ Device: class {} }));
let me = { id: '11111111-1111-1111-1111-111111111111', handle: 'Kim' };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: me }) }));

import Learn, { timing } from './Learn';
import Dashboard from './Dashboard';
import Feed from './Feed';
import Panels from './Panels';
import LiveRoom, { deps } from './LiveRoom';
import { ToastProvider } from '../components/Toast';

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname + l.search}</div>; }
const renderAt = (url, el) => render(
  <ToastProvider><MemoryRouter initialEntries={[url]}><Routes><Route path="*" element={<>{el}<Where /></>} /></Routes></MemoryRouter></ToastProvider>
);

beforeEach(() => {
  calls.length = 0;
  routes = {};
  sock.reset();
  me = { id: '11111111-1111-1111-1111-111111111111', handle: 'Kim' };
  timing.reveal = 10; timing.speedRound = 400;
});

describe('Learn', () => {
  test('trivia: all seven answered right is a perfect score, saved as 7/7, and the server-awarded badge is shown', async () => {
    const user = userEvent.setup();
    routes['POST /api/games/trivia/score'] = { best: 7, plays: 1, newBest: true };
    routes['GET /api/achievements'] = [{ key: 'quizWhiz', unlocked: true }];
    renderAt('/learn', <Learn />);
    for (let i = 0; i < QUIZ.length; i++) {
      await screen.findByText(`Question ${i + 1} of ${QUIZ.length}`);
      await user.click(screen.getByRole('button', { name: QUIZ[i].opts[QUIZ[i].a] }));
    }
    expect(await screen.findByText('Perfect score — true collector!')).toBeTruthy();
    expect(await screen.findByText(/Quiz Whiz earned/)).toBeTruthy();
    expect(calls.find((c) => c.path === '/api/games/trivia/score').body).toEqual({ score: 7, outOf: 7 });
  });

  test('trivia: wrong answers count as wrong; no badge claim when the server has not awarded it', async () => {
    const user = userEvent.setup();
    routes['POST /api/games/trivia/score'] = { best: 0, plays: 1, newBest: false };
    renderAt('/learn', <Learn />);
    for (let i = 0; i < QUIZ.length; i++) {
      await screen.findByText(`Question ${i + 1} of ${QUIZ.length}`);
      await user.click(screen.getByRole('button', { name: QUIZ[i].opts[(QUIZ[i].a + 1) % 4] }));
    }
    await waitFor(() => expect(calls.find((c) => c.path === '/api/games/trivia/score')?.body).toEqual({ score: 0, outOf: 7 }));
    expect(screen.queryByText(/Quiz Whiz earned/)).toBeNull();
    expect(calls.some((c) => c.path === '/api/achievements')).toBe(false);
  });

  test('Speed ID: a wrong pick ends the run and the score shown is the score saved', async () => {
    const user = userEvent.setup();
    routes['POST /api/games/speed/score'] = (b) => ({ best: b.score, plays: 1, newBest: true });
    renderAt('/learn', <Learn />);
    const game = screen.getByTestId('speed-game');
    await user.click(within(game).getByRole('button', { name: '▶ Start' }));
    // answer right twice by reading the description, then wrong on purpose
    const { GLOSSARY } = await import('../lib/learnData');
    for (let k = 0; k < 2; k++) {
      const desc = await waitFor(() => { const p = game.querySelector('p'); if (!p) throw new Error('no round'); return p.textContent; });
      const right = GLOSSARY.find((g) => g.d === desc).nm;
      await user.click(within(game).getByRole('button', { name: right }));
      await waitFor(() => expect(game.querySelector('.score').textContent).toBe(String(k + 1)));
      await waitFor(() => expect(game.querySelector('.quiz-opt:not([disabled])')).toBeTruthy());
    }
    const desc = game.querySelector('p').textContent;
    const wrong = [...game.querySelectorAll('.quiz-opt')].find((b) => b.textContent !== GLOSSARY.find((g) => g.d === desc).nm);
    await user.click(wrong);
    await within(game).findByRole('button', { name: '↻ Play Again' });
    expect(game.querySelector('.score').textContent).toBe('2');
    await waitFor(() => expect(calls.find((c) => c.path === '/api/games/speed/score')?.body).toEqual({ score: 2 }));
  });

  test('Speed ID: running out of time ends the run too', async () => {
    const user = userEvent.setup();
    routes['POST /api/games/speed/score'] = { best: 0, plays: 1, newBest: false };
    renderAt('/learn', <Learn />);
    const game = screen.getByTestId('speed-game');
    await user.click(within(game).getByRole('button', { name: '▶ Start' }));
    await within(game).findByRole('button', { name: '↻ Play Again' }, { timeout: 2000 });
    expect(calls.find((c) => c.path === '/api/games/speed/score').body).toEqual({ score: 0 });
  });
});

describe('Dashboard', () => {
  beforeEach(() => {
    routes['GET /api/dashboard'] = { stats: { activeListings: 1, offersSent: 0, posts: 1, battles: 0, roomsHosted: 0, collectionCount: 0 }, challenge: { tag: '#SwirlChallenge', entries: 1 }, achievements: { unlocked: 2, total: 8 }, games: { trivia: { best: 5, plays: 2 }, speed: { best: 0, plays: 0 } } };
    routes['GET /api/achievements'] = [{ key: 'listed', name: 'First Listing', icon: '🆕', description: 'List a marble', unlocked: true }, { key: 'traded', name: 'Trader', icon: '🤝', description: 'Make a deal', unlocked: false }];
    routes['GET /api/activity'] = [{ seq: 1, text: 'Listed "Blue" on the marketplace', created_at: new Date().toISOString() }];
    routes['GET /api/templates'] = [{ id: 't1', name: 'Std Swirl', type: 'sale', price_cents: 4200 }];
  });

  test('shows the server\'s numbers, badges and activity', async () => {
    renderAt('/dashboard', <Dashboard />);
    await screen.findByText('At a glance');
    expect(screen.getByText('Active listings').closest('.stat-card').textContent).toMatch(/1/);
    expect(screen.getByText('1 entry so far.')).toBeTruthy();
    expect(screen.getByText('2 of 8 unlocked')).toBeTruthy();
    expect(screen.getByText('First Listing').closest('.badge-card').className).toMatch(/unlocked/);
    expect(screen.getByText('Trader').closest('.badge-card').className).not.toMatch(/unlocked/);
    expect(screen.getByText(/Listed "Blue" on the marketplace/)).toBeTruthy();
  });

  test('a template: Delete removes it on the server and from the list', async () => {
    const user = userEvent.setup();
    routes['DELETE /api/templates/t1'] = () => null;
    renderAt('/dashboard', <Dashboard />);
    const row = (await screen.findByText(/Std Swirl/)).closest('.template-row');
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(document.querySelectorAll('.template-row')).toHaveLength(0));
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/templates/t1')).toBe(true);
  });

  test('Use navigates to /market?template=<id>', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard', <Dashboard />);
    const row = (await screen.findByText(/Std Swirl/)).closest('.template-row');
    await user.click(within(row).getByRole('button', { name: 'Use' }));
    expect(screen.getByTestId('where').textContent).toBe('/market?template=t1');
  });
});

describe('Feed', () => {
  test('posting sends the text and shows the new post; liking uses the server\'s count', async () => {
    const user = userEvent.setup();
    let posts = [];
    routes['GET /api/feed'] = () => posts;
    routes['GET /api/collection'] = [];
    routes['POST /api/feed'] = (b) => { posts = [{ id: 'p1', text: b.text, author_id: me.id, author_handle: 'Kim', like_count: 0, comment_count: 0, liked_by_me: false, created_at: new Date().toISOString() }]; return posts[0]; };
    routes['POST /api/feed/p1/like'] = { liked: true, likeCount: 3 };
    renderAt('/feed', <Feed />);
    await user.type(await screen.findByPlaceholderText(/Share a haul/), '#SwirlChallenge my entry');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('#SwirlChallenge my entry')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/feed').body).toEqual({ text: '#SwirlChallenge my entry' });
    await user.click(screen.getByRole('button', { name: /🤍 0/ }));
    expect(await screen.findByRole('button', { name: /❤️ 3/ })).toBeTruthy();
  });
});

describe('Feed comments', () => {
  test('my comments get Delete, other people\'s get ⚑ Report; delete updates the list and the count', async () => {
    const user = userEvent.setup();
    routes['GET /api/feed'] = [{ id: 'p1', text: 'haul', author_id: 'someone', author_handle: 'Ann', like_count: 0, comment_count: 2, liked_by_me: false, created_at: new Date().toISOString() }];
    routes['GET /api/collection'] = [];
    routes['GET /api/feed/p1/comments'] = [
      { id: 'c1', text: 'mine', author_id: me.id, author_handle: 'Kim', created_at: '' },
      { id: 'c2', text: 'theirs', author_id: 'x', author_handle: 'Bob', created_at: '' },
    ];
    routes['DELETE /api/feed/comments/c1'] = () => null;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAt('/feed', <Feed />);
    await user.click(await screen.findByRole('button', { name: '💬 2' }));
    const theirs = (await screen.findByText('theirs')).closest('.comment');
    expect(within(theirs).getByTitle('Report this comment')).toBeTruthy();
    expect(within(theirs).queryByRole('button', { name: /Delete/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete comment by Kim' }));
    await waitFor(() => expect(screen.queryByText('mine')).toBeNull());
    expect(screen.getByRole('button', { name: '💬 1' })).toBeTruthy();
    confirm.mockRestore();
  });
});

describe('Panels', () => {
  test('Go Live creates a live room titled "<handle>\'s Stream" and opens /live/<id>', async () => {
    const user = userEvent.setup();
    routes['GET /api/rooms'] = [];
    routes['POST /api/rooms'] = (b) => ({ id: 'r1', ...b, status: 'live' });
    renderAt('/panels?golive=1', <Panels />);
    await user.click(await screen.findByRole('button', { name: '● Go Live Now' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/live/r1'));
    expect(calls.find((c) => c.method === 'POST').body).toMatchObject({ title: "Kim's Stream", goLiveNow: true, maxGuests: 6 });
  });

  test('live rooms are listed with a Join button that opens the room link', async () => {
    const user = userEvent.setup();
    routes['GET /api/rooms'] = [{ id: 'r9', title: "Joe's Stream", status: 'live', host_id: 'x', host_handle: 'Joe', category: 'General', guest_count: 1, max_guests: 6 }];
    renderAt('/panels', <Panels />);
    await user.click(await screen.findByRole('button', { name: "Join Joe's Stream" }));
    expect(screen.getByTestId('where').textContent).toBe('/live/r9');
  });
});

// ---------------- live room ----------------
const HOST = '11111111-1111-1111-1111-111111111111';
const GUEST = '22222222-2222-2222-2222-222222222222';
const room = { id: '33333333-3333-3333-3333-333333333333', title: "Kim's Stream", host_id: HOST, host_handle: 'Kim', status: 'live' };

function fakeTrack(kind) { return { kind, enabled: true, readyState: 'live', stop: vi.fn(), getSettings: () => ({}), addEventListener() {} }; }
let mcState;
function installMedia({ publishError, gum = true } = {}) {
  mcState = { published: [], joined: false, opts: null };
  deps.createMediaClient = (opts) => {
    mcState.opts = opts;
    return {
      join: async () => { mcState.joined = true; },
      publish: vi.fn(async (track, source, o) => {
        if (publishError && !(o && o.takeover)) throw Object.assign(new Error(publishError), { code: publishError });
        mcState.published.push({ source, takeover: !!o?.takeover });
      }),
      unpublish: vi.fn(async () => {}), replaceTrack: vi.fn(async () => {}), leave: vi.fn(async () => {}),
    };
  };
  deps.mediaDevices = () => ({
    getUserMedia: gum ? async () => { const v = fakeTrack('video'); const a = fakeTrack('audio'); mcState.tracks = { video: v, audio: a }; return { getVideoTracks: () => [v], getAudioTracks: () => [a], getTracks: () => [v, a] }; } : async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
    enumerateDevices: async () => [],
  });
}
globalThis.MediaStream = globalThis.MediaStream || class { constructor(t) { this.t = t; } };
HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };

describe('LiveRoom', () => {
  test('a guest takes a seat, joins the room channel and goes on stage with camera and mic', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    await waitFor(() => expect(mcState.published.map((p) => p.source)).toEqual(['video', 'audio']));
    expect(sock.sent.find((s) => s.ev === 'room:join').payload).toEqual({ roomId: room.id });
    expect(document.querySelector('.lr-tile[data-self="1"] .lr-tile-label').textContent).toMatch(/Joe/);
  });

  test('chat: Enter sends; messages from the server appear with the author in bold', async () => {
    const user = userEvent.setup();
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    await user.type(screen.getByPlaceholderText('Say something…'), 'hello there{enter}');
    expect(sock.sent.find((s) => s.ev === 'room:chat').payload).toEqual({ roomId: room.id, text: 'hello there' });
    expect(screen.getByPlaceholderText('Say something…').value).toBe('');
    sock.push('room:chat', { id: 'm1', roomId: room.id, userId: HOST, handle: 'Kim', text: 'welcome!', at: new Date().toISOString() });
    const msg = await screen.findByText('welcome!');
    expect(msg.closest('.lc-msg').querySelector('b').textContent).toBe('Kim');
    sock.push('room:chat', { id: 'm2', roomId: 'another-room', userId: HOST, handle: 'Kim', text: 'wrong room', at: '' });
    expect(screen.queryByText('wrong room')).toBeNull();
  });

  test('blocked and throttled messages are explained to the sender without echoing the text', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    sock.push('room:chat:blocked', { roomId: room.id, reason: "This message breaks the host's chat rules" });
    expect(await screen.findByText(/breaks the host's chat rules/)).toBeTruthy();
    sock.push('room:chat:throttled', { roomId: room.id, retryMs: 2100 });
    expect(await screen.findByText(/chat again in 3s/)).toBeTruthy();
  });

  test('host: the 🛡️ badge counts flagged messages and lists who, what and which word', async () => {
    const user = userEvent.setup();
    installMedia();
    renderAt('/live/x', <LiveRoom room={room} />);
    const badge = screen.getByTitle('Messages blocked by your chat rules');
    expect(badge.textContent).toMatch(/0/);
    sock.push('moderation:flagged', { roomId: room.id, userId: GUEST, handle: 'Joe', text: 'you SCAMMER', word: 'scammer', at: '2026-01-01T00:00:00Z' });
    await waitFor(() => expect(badge.textContent).toMatch(/1/));
    await user.click(badge);
    expect(document.querySelector('.lc-flag').textContent).toMatch(/Joe.*SCAMMER.*blocked: scammer/s);
  });

  test('viewers get 💰 and the host does not; a server refusal is shown in the tip dialog and nothing navigates', async () => {
    const user = userEvent.setup();
    installMedia();
    const { unmount } = renderAt('/live/x', <LiveRoom room={room} />);
    expect(screen.queryByTitle('Send a tip')).toBeNull();
    unmount();
    me = { id: GUEST, handle: 'Joe' };
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    routes['POST /api/payments/tip'] = () => { throw Object.assign(new Error('This host has not set up payouts yet'), { status: 400 }); };
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, assign } });
    try {
      renderAt('/live/x', <LiveRoom room={room} />);
      await user.click(screen.getByTitle('Send a tip'));
      expect(screen.getByText('💰 Send a Tip')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Continue to payment' }));
      expect(await screen.findByText('This host has not set up payouts yet')).toBeTruthy();
      expect(calls.find((c) => c.path === '/api/payments/tip').body).toMatchObject({ roomId: room.id, amountCents: 500 });
      expect(assign).not.toHaveBeenCalled();
    } finally { Object.defineProperty(window, 'location', { configurable: true, value: orig }); }
  });

  test('host commands go out with a commandId; the room follows server state by version, ignoring stale snapshots', async () => {
    const user = userEvent.setup();
    installMedia();
    sock.acks['room:command'] = () => ({ ok: true, version: 1 });
    renderAt('/live/x', <LiveRoom room={room} />);
    await user.click(screen.getByTitle('Spotlight layout'));
    const cmd = sock.sent.find((s) => s.ev === 'room:command').payload;
    expect(cmd).toMatchObject({ roomId: room.id, type: 'layout', value: 'spotlight' });
    expect(typeof cmd.commandId).toBe('string');
    sock.push('room:state', { roomId: room.id, version: 2, layout: 'spotlight', muted: {}, cameraOff: {} });
    await waitFor(() => expect(document.querySelector('.lr-stage').dataset.layout).toBe('spotlight'));
    sock.push('room:state', { roomId: room.id, version: 1, layout: 'grid', muted: {}, cameraOff: {} }); // late, older
    expect(document.querySelector('.lr-stage').dataset.layout).toBe('spotlight');
  });

  test('when the host mutes a guest, that guest\'s mic is really disabled on their device', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    await waitFor(() => expect(mcState.published).toHaveLength(2));
    sock.push('room:state', { roomId: room.id, version: 1, layout: 'grid', muted: { [GUEST]: true }, cameraOff: {} });
    const mic = await screen.findByTitle('The host muted you');
    expect(mic.disabled).toBe(true);
    expect(mcState.tracks.audio.enabled).toBe(false);
    expect(mcState.tracks.video.enabled).toBe(true);
    sock.push('room:state', { roomId: room.id, version: 2, layout: 'grid', muted: {}, cameraOff: {} });
    await waitFor(() => expect(mcState.tracks.audio.enabled).toBe(true));
  });

  test('the same person live on another device: this one becomes a remote control and can take over', async () => {
    const user = userEvent.setup();
    installMedia({ publishError: 'publishing-elsewhere' });
    renderAt('/live/x', <LiveRoom room={room} />);
    expect(await screen.findByText(/already live from another device/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: "Use this device's camera instead" }));
    await waitFor(() => expect(mcState.published).toEqual([{ source: 'video', takeover: true }, { source: 'audio', takeover: true }]));
  });

  test('no camera permission: the viewer still watches and chats, and is told why', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia({ gum: false });
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    expect(await screen.findByText(/Camera and microphone are not available/)).toBeTruthy();
    expect(screen.getByPlaceholderText('Say something…')).toBeTruthy();
    expect(mcState.joined).toBe(true);
  });

  test('a full stage: watch only, no camera asked for', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = () => { throw Object.assign(new Error('This room is full'), { status: 409 }); };
    renderAt('/live/x', <LiveRoom room={room} />);
    expect(await screen.findByText(/stage is full/)).toBeTruthy();
    await waitFor(() => expect(mcState.joined).toBe(true));
    expect(mcState.published).toEqual([]);
  });

  test('the stream ends: everyone sees it has ended and local media stops', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    await waitFor(() => expect(mcState.published).toHaveLength(2));
    sock.push('room:ended', { roomId: room.id });
    expect(await screen.findByText('This stream has ended.')).toBeTruthy();
    expect(mcState.tracks.video.stop).toHaveBeenCalled();
    expect(mcState.tracks.audio.stop).toHaveBeenCalled();
  });

  test('a dropped connection shows "Reconnecting…" and rejoins the room channel on reconnect', async () => {
    me = { id: GUEST, handle: 'Joe' };
    installMedia();
    routes[`POST /api/rooms/${room.id}/join`] = { ok: true };
    renderAt('/live/x', <LiveRoom room={room} />);
    await waitFor(() => expect(mcState.published).toHaveLength(2));
    sock.push('disconnect');
    expect(await screen.findByText(/Reconnecting/)).toBeTruthy();
    sock.sent.length = 0;
    sock.push('connect');
    await waitFor(() => expect(screen.queryByText(/Reconnecting/)).toBeNull());
    expect(sock.sent.find((s) => s.ev === 'room:join').payload).toEqual({ roomId: room.id });
  });
});
