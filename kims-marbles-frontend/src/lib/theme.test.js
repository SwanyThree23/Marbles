// Theme choice: system by default, a manual Light/Dark wins and persists, System resumes
// following the OS live. Plus WCAG AA contrast measured from the REAL stylesheet.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as theme from './theme.js';

function fakeMedia(dark) {
  const listeners = new Set();
  const mql = { matches: dark, addEventListener: (_t, fn) => listeners.add(fn), removeEventListener: (_t, fn) => listeners.delete(fn) };
  return { matchMedia: () => mql, flip(next) { mql.matches = next; listeners.forEach((fn) => fn({ matches: next })); } };
}
const attr = () => document.documentElement.getAttribute('data-theme');

beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme'); theme.resetForTests(); });

describe('choice and resolution', () => {
  test('with no choice it follows the system, live', () => {
    const m = fakeMedia(true);
    theme.initTheme(m.matchMedia);
    expect(theme.getThemeChoice()).toBe('system');
    expect(attr()).toBe('dark');
    m.flip(false);
    expect(attr()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  test('a manual choice wins over the system, survives a reload, and System resumes following', () => {
    const m = fakeMedia(false);
    theme.initTheme(m.matchMedia);
    theme.setThemeChoice('dark');
    expect(attr()).toBe('dark');
    m.flip(true); m.flip(false);
    expect(attr()).toBe('dark', 'the OS must not override an explicit choice');
    theme.resetForTests();
    theme.initTheme(m.matchMedia);                       // "reload"
    expect(theme.getThemeChoice()).toBe('dark');
    expect(attr()).toBe('dark');
    theme.setThemeChoice('system');
    expect(localStorage.getItem('kmTheme')).toBe(null);
    expect(attr()).toBe('light');
    m.flip(true);
    expect(attr()).toBe('dark');
  });

  test('junk in storage is ignored', () => {
    localStorage.setItem('kmTheme', 'neon');
    theme.initTheme(fakeMedia(false).matchMedia);
    expect(theme.getThemeChoice()).toBe('system');
  });

  test('a local change is sent to my other devices; a change FROM another device is applied but not echoed back', () => {
    const send = vi.fn();
    theme.setSyncSender(send);
    theme.initTheme(fakeMedia(false).matchMedia);
    theme.setThemeChoice('dark');
    expect(send).toHaveBeenCalledWith('theme', 'dark');
    send.mockClear();
    theme.applyRemoteChoice('light');
    expect(attr()).toBe('light');
    expect(send).not.toHaveBeenCalled();
    theme.applyRemoteChoice('purple');
    expect(attr()).toBe('light', 'unknown values from the network are ignored');
  });

  test('subscribers hear every change', () => {
    theme.initTheme(fakeMedia(false).matchMedia);
    const fn = vi.fn();
    const off = theme.subscribeTheme(fn);
    theme.setThemeChoice('dark');
    expect(fn).toHaveBeenLastCalledWith({ choice: 'dark', resolved: 'dark' });
    off();
  });
});

// ---------------- contrast, from the real CSS ----------------
const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
function tokens(selector) {
  const i = css.indexOf(selector);
  if (i === -1) throw new Error(`no ${selector} block in index.css`);
  const block = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  return Object.fromEntries([...block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('WCAG AA contrast (4.5:1) for every text/background pair, both palettes', () => {
  const light = tokens(':root {');
  const dark = { ...light, ...tokens(':root[data-theme="dark"]') };
  const PAIRS = [['text', 'bg'], ['text', 'panel'], ['text', 'panel2'], ['text-dim', 'bg'], ['text-dim', 'panel'], ['text-dim', 'panel2'],
    ['accent-text', 'bg'], ['accent-text', 'panel'], ['on-accent', 'accent'], ['on-primary', 'primary'], ['danger-text', 'panel']];
  for (const [name, pal] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of PAIRS) {
      test(`${name}: ${fg} on ${bg}`, () => {
        expect(pal[fg], `--${fg} missing`).toBeTruthy();
        expect(pal[bg], `--${bg} missing`).toBeTruthy();
        expect(ratio(pal[fg], pal[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  test('the dark block and the system-dark block define the same values', () => {
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const sys = (() => { const i = media.indexOf(':root:not([data-theme="light"])'); const b = media.slice(media.indexOf('{', i) + 1, media.indexOf('}', i)); return Object.fromEntries([...b.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]])); })();
    expect(sys).toEqual(tokens(':root[data-theme="dark"]'));
  });
});

describe('no flash: index.html applies the theme before any app code', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  test('an inline script in <head> sets data-theme from storage or the system', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const m = head.match(/<script>([\s\S]*?)<\/script>/);
    expect(m, 'inline <script> in <head>').toBeTruthy();
    for (const [stored, sysDark, want] of [['dark', false, 'dark'], ['light', true, 'light'], [null, true, 'dark'], [null, false, 'light'], ['bogus', true, 'dark']]) {
      const el = { setAttribute: vi.fn(), style: {} };
      const fn = new Function('localStorage', 'matchMedia', 'document', m[1]);
      fn({ getItem: () => stored }, () => ({ matches: sysDark }), { documentElement: el });
      expect(el.setAttribute).toHaveBeenCalledWith('data-theme', want);
    }
  });
});
