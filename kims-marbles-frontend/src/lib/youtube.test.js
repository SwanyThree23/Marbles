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
