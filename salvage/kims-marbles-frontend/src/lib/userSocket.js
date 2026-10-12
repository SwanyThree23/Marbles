// userSocket.js — ONE authenticated real-time connection per device, outside any room.
//
// This is what makes "change a setting on my desktop, see it on my phone" work: every
// socket of a logged-in user joins a private server-side channel, so a setting changed on
// one device is relayed to that same person's other devices (and nobody else). It also
// registers this device so Me can show which devices are signed in.
import { io } from 'socket.io-client';
import { API_URL, getFreshToken } from './api';

let socket = null;
let devices = [];
const settingHandlers = new Map(); // key -> Set<fn>
const deviceListeners = new Set();

export function getDeviceId() {
  let id = localStorage.getItem('kmDeviceId');
  if (!id) { id = `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; localStorage.setItem('kmDeviceId', id); }
  return id;
}
const deviceLabel = () =>
  (/Mobi|Android|iPhone/i.test(navigator.userAgent) || window.innerWidth < 760 ? '📱 Mobile' : '💻 Desktop');

export function startUserSocket() {
  if (socket) return; // idempotent
  // `auth` is a function so a reconnect after the access token expired still carries a fresh one
  socket = io(API_URL, { auth: (cb) => getFreshToken().then((token) => cb({ token })) });
  socket.on('connect', () => socket.emit('device:register', { deviceId: getDeviceId(), label: deviceLabel() }));
  socket.on('settings:sync', ({ key, value } = {}) => {
    const set = settingHandlers.get(key);
    if (set) set.forEach((fn) => fn(value));
  });
  socket.on('device:list', (list) => { devices = Array.isArray(list) ? list : []; deviceListeners.forEach((fn) => fn(devices)); });
}

export function stopUserSocket() {
  if (!socket) return;
  socket.disconnect();
  socket = null;
  devices = [];
  deviceListeners.forEach((fn) => fn(devices));
}

// tell this user's OTHER devices about a setting change (no-op until connected)
export function emitSetting(key, value) {
  if (socket && socket.connected) socket.emit('settings:sync', { key, value });
}

export function onRemoteSetting(key, fn) {
  if (!settingHandlers.has(key)) settingHandlers.set(key, new Set());
  settingHandlers.get(key).add(fn);
  return () => settingHandlers.get(key)?.delete(fn);
}

export function onDevices(fn) {
  deviceListeners.add(fn);
  fn(devices);
  return () => deviceListeners.delete(fn);
}
