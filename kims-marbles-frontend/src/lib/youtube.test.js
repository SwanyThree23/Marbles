import { test, expect } from 'vitest';
import { parseYoutubeId, embedUrl, playerCommand } from './youtube';

test('accepts every common YouTube link shape and a bare id', () => {
  const id = 'dQw4w9WgXcQ';
  for (const s of [id, `https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?feature=share&v=${id}&t=42`, `https://youtu.be/${id}`, `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`, `  ${id}  `, `www.youtube.com/watch?v=${id}`]) {
    expect(parseYoutubeId(s), s).toBe(id);
  }
});

test('rejects anything else, including look-alike domains', () => {
  for (const s of ['', 'hello', 'dQw4w9WgXc', 'dQw4w9WgXcQQ', 'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9Wg<cQ', 'javascript:alert(1)', null, undefined, 42]) {
    expect(parseYoutubeId(s), String(s)).toBe(null);
  }
});

test('the embed uses the privacy-enhanced domain, the JS API, and starts muted (browsers block sound without a tap)', () => {
  const u = new URL(embedUrl('dQw4w9WgXcQ'));
  expect(u.origin).toBe('https://www.youtube-nocookie.com');
  expect(u.pathname).toBe('/embed/dQw4w9WgXcQ');
  expect(u.searchParams.get('enablejsapi')).toBe('1');
  expect(u.searchParams.get('mute')).toBe('1');
  expect(u.searchParams.get('playsinline')).toBe('1');
  expect(() => embedUrl('bad')).toThrow();
});

test('host controls map to player commands', () => {
  expect(playerCommand('play')).toEqual([{ event: 'command', func: 'playVideo', args: [] }]);
  expect(playerCommand('pause')).toEqual([{ event: 'command', func: 'pauseVideo', args: [] }]);
  expect(playerCommand('restart')).toEqual([{ event: 'command', func: 'seekTo', args: [0, true] }, { event: 'command', func: 'playVideo', args: [] }]);
  expect(playerCommand('explode')).toEqual([]);
});

import { createClock, correction, readPlayerMessage, playerError, LISTEN } from './youtube';

test('the room clock: moves while playing, stands still while paused', () => {
  let t = 1000;
  const clock = createClock(() => t);
  clock.set({ position: 10, playing: true });
  t += 2500;
  expect(clock.now()).toEqual({ position: 12.5, playing: true });
  clock.set({ position: 30, playing: false });
  t += 10_000;
  expect(clock.now()).toEqual({ position: 30, playing: false });
});

test('correction: small drift is left alone, big drift is seeked, wrong play/pause is fixed', () => {
  const seek = (s) => ({ event: 'command', func: 'seekTo', args: [s, true] });
  const play = { event: 'command', func: 'playVideo', args: [] };
  const pause = { event: 'command', func: 'pauseVideo', args: [] };
  expect(correction({ position: 50, playing: true }, { currentTime: 50.8, playerState: 1 })).toEqual([]);
  expect(correction({ position: 50, playing: true }, { currentTime: 47, playerState: 1 })).toEqual([seek(50)]);
  expect(correction({ position: 50, playing: true }, { currentTime: 50, playerState: 2 })).toEqual([play]);
  expect(correction({ position: 50, playing: true }, { currentTime: 0, playerState: -1 })).toEqual([seek(50), play]);
  expect(correction({ position: 50, playing: true }, { currentTime: 49, playerState: 3 })).toEqual([], 'buffering: give it a moment');
  expect(correction({ position: 20, playing: false }, { currentTime: 25, playerState: 1 })).toEqual([pause, seek(20)]);
  expect(correction({ position: 20, playing: false }, { currentTime: 20.3, playerState: 2 })).toEqual([]);
  expect(correction({ position: 20, playing: true }, { currentTime: undefined, playerState: undefined })).toEqual([], 'nothing known about the player yet');
});

test('player messages: YouTube sends JSON strings with partial info; anything else is ignored', () => {
  expect(readPlayerMessage('{"event":"infoDelivery","info":{"currentTime":3.2,"playerState":1}}')).toEqual({ event: 'infoDelivery', info: { currentTime: 3.2, playerState: 1 } });
  expect(readPlayerMessage('{"event":"onError","info":150}')).toEqual({ event: 'onError', info: 150 });
  expect(readPlayerMessage('not json')).toBe(null);
  expect(readPlayerMessage({ event: 'x' })).toBe(null);
  expect(JSON.parse(LISTEN)).toMatchObject({ event: 'listening' });
});

test('player errors become a sentence a person can act on', () => {
  expect(playerError(150)).toMatch(/doesn't allow/);
  expect(playerError(101)).toMatch(/doesn't allow/);
  expect(playerError(100)).toMatch(/removed or is private/);
  expect(playerError(2)).toMatch(/link/);
  expect(playerError(999)).toMatch(/can't be played/);
});

import { commandsFor } from './youtube';
test('a viewer follows each host action at the host\'s position', () => {
  const f = (a, p) => commandsFor(a, p).map((c) => `${c.func}${c.args.length ? `(${c.args[0]})` : ''}`).join(' ');
  expect(f('pause', 42)).toBe('pauseVideo seekTo(42)');
  expect(f('play', 42)).toBe('seekTo(42) playVideo');
  expect(f('seek', 90)).toBe('seekTo(90)');
  expect(f('restart', 77)).toBe('seekTo(0) playVideo');
  expect(f('dance', 1)).toBe('');
});
