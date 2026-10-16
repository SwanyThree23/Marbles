// Light / Dark / System. "System" (the default) follows the OS setting live; an explicit choice
// is saved and wins. index.html applies the same rule before first paint, so there is no flash.
// A local change is sent to the same person's other devices (setSyncSender); a change that
// arrived from another device is applied without being echoed back.
const KEY = 'kmTheme';
const CHOICES = ['light', 'dark', 'system'];

let mql = null;
let choice = 'system';
let sendSync = null;
const listeners = new Set();

const read = () => { try { return localStorage.getItem(KEY); } catch (_e) { return null; } };
const write = (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (_e) { /* storage blocked */ } };

export const getThemeChoice = () => choice;
export const resolvedTheme = () => (choice === 'system' ? (mql && mql.matches ? 'dark' : 'light') : choice);

function apply() {
  const t = resolvedTheme();
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
  listeners.forEach((fn) => fn({ choice, resolved: t }));
}

function onSystemChange() { if (choice === 'system') apply(); }

export function initTheme(matchMediaFn = typeof window !== 'undefined' ? window.matchMedia?.bind(window) : null) {
  const saved = read();
  choice = saved === 'light' || saved === 'dark' ? saved : 'system';
  if (mql) mql.removeEventListener('change', onSystemChange);
  mql = matchMediaFn ? matchMediaFn('(prefers-color-scheme: dark)') : null;
  if (mql) mql.addEventListener('change', onSystemChange);
  apply();
}

function setChoice(next, { fromRemote = false } = {}) {
  if (!CHOICES.includes(next)) return;
  choice = next;
  write(next === 'system' ? null : next);
  apply();
  if (!fromRemote && sendSync) sendSync('theme', next);
}

export const setThemeChoice = (next) => setChoice(next);
export const applyRemoteChoice = (next) => setChoice(next, { fromRemote: true });
export const setSyncSender = (fn) => { sendSync = fn; };
export function subscribeTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function resetForTests() {
  if (mql) mql.removeEventListener('change', onSystemChange);
  mql = null; choice = 'system'; sendSync = null; listeners.clear();
}
