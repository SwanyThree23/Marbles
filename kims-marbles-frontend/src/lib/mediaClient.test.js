// The SFU client's state machine, against a scripted server and a fake mediasoup Device.
// Real media through the real SFU is covered by the real-browser suite.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createMediaClient, ACK_TIMEOUT_MS } from './mediaClient';

function fakeSocket(handlers) {
  const listeners = new Map();
  const sent = [];
  return {
    connected: true,
    sent,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); },
    off(ev, fn) { listeners.get(ev)?.delete(fn); },
    emit(ev, payload, ack) {
      sent.push({ ev, payload });
      const h = handlers[ev];
      if (!h) return; // silence: lets a test exercise the timeout
      Promise.resolve().then(() => h(payload)).then((res) => ack && ack(res));
    },
    push(ev, data) { listeners.get(ev)?.forEach((fn) => fn(data)); },
    count(ev) { return listeners.get(ev)?.size || 0; },
  };
}

let ids = 0;
class FakeTransport {
  constructor(opts, direction) { this.id = opts.id; this.opts = opts; this.direction = direction; this.l = {}; this.closed = false; }
  on(ev, fn) { this.l[ev] = fn; }
  close() { this.closed = true; }
  async consume({ id, producerId, kind }) { return { id, producerId, kind, track: { kind, id: `track-${producerId}` }, closed: false, close() { this.closed = true; } }; }
  async produce({ track, appData }) {
    await new Promise((res, rej) => this.l.connect ? this.l.connect({ dtlsParameters: { d: 1 } }, res, rej) : res());
    const { id } = await new Promise((res, rej) => this.l.produce({ kind: track.kind, rtpParameters: { r: 1 }, appData }, res, rej));
    return { id, kind: track.kind, closed: false, close() { this.closed = true; }, replaceTrack: vi.fn(async () => {}), on() {} };
  }
}
const devices = [];
class FakeDevice {
  constructor() { this.loaded = null; this.rtpCapabilities = { caps: true }; devices.push(this); }
  async load({ routerRtpCapabilities }) { this.loaded = routerRtpCapabilities; }
  canProduce() { return true; }
  createSendTransport(o) { return (this.send = new FakeTransport(o, 'send')); }
  createRecvTransport(o) { return (this.recv = new FakeTransport(o, 'recv')); }
}

function server(extra = {}) {
  const live = []; // producers the server would report on join
  const h = {
    'ms:join': () => ({ rtpCapabilities: { codecs: [] }, existingProducers: [...live] }),
    'ms:create-transport': ({ direction }) => ({ id: `${direction}-${++ids}`, iceParameters: {}, iceCandidates: [], dtlsParameters: {} }),
    'ms:connect-transport': () => ({ ok: true }),
    'ms:consume': ({ producerId }) => ({ id: `c-${producerId}`, producerId, kind: producerId.startsWith('a') ? 'audio' : 'video', rtpParameters: {} }),
    'ms:resume-consumer': () => ({ ok: true }),
    'ms:produce': ({ appData }) => ({ id: `p-${appData.source}-${++ids}` }),
    'ms:close-producer': () => ({ ok: true }),
    'ms:leave': () => ({ ok: true }),
    ...extra,
  };
  return { h, live };
}

function setup(extra) {
  const srv = server(extra);
  const socket = fakeSocket(srv.h);
  const tracks = new Map();
  const ended = [];
  const errors = [];
  const replaced = vi.fn();
  const mc = createMediaClient({
    socket, roomId: 'room-1', Device: FakeDevice,
    getIceConfig: async () => ({ iceServers: [{ urls: ['turn:x'] }], iceTransportPolicy: 'relay' }),
    onTrack: (info, track) => tracks.set(info.producerId, { info, track }),
    onTrackEnded: (id) => { ended.push(id); tracks.delete(id); },
    onReplaced: replaced,
    onError: (e) => errors.push(e),
  });
  return { srv, socket, mc, tracks, ended, errors, replaced };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { devices.length = 0; });

describe('mediaClient', () => {
  test('join loads the router capabilities, uses the ICE config, and plays everything already live', async () => {
    const { srv, mc, tracks, socket } = setup();
    srv.live.push({ producerId: 'v1', userId: 'u-host', handle: 'Kim', source: 'video', kind: 'video' }, { producerId: 'a1', userId: 'u-host', handle: 'Kim', source: 'audio', kind: 'audio' });
    await mc.join();
    expect(socket.sent[0]).toEqual({ ev: 'ms:join', payload: { roomId: 'room-1' } });
    expect(devices[0].loaded).toEqual({ codecs: [] });
    expect(devices[0].recv.opts).toMatchObject({ iceServers: [{ urls: ['turn:x'] }], iceTransportPolicy: 'relay' });
    expect([...tracks.keys()].sort()).toEqual(['a1', 'v1']);
    expect(tracks.get('v1').info).toMatchObject({ userId: 'u-host', handle: 'Kim', source: 'video', kind: 'video' });
    // every consumer is resumed (the server creates them paused)
    expect(socket.sent.filter((s) => s.ev === 'ms:resume-consumer').map((s) => s.payload.consumerId).sort()).toEqual(['c-a1', 'c-v1']);
  });

  test('a producer that appears later is played; when it closes, its track ends', async () => {
    const { mc, tracks, ended, socket } = setup();
    await mc.join();
    socket.push('ms:new-producer', { producerId: 'v9', userId: 'u2', handle: 'Guest', source: 'video', kind: 'video' });
    await vi.waitFor(() => expect(tracks.has('v9')).toBe(true));
    socket.push('ms:new-producer', { producerId: 'v9', userId: 'u2', handle: 'Guest', source: 'video', kind: 'video' }); // a duplicate announcement
    await flush();
    expect(socket.sent.filter((s) => s.ev === 'ms:consume')).toHaveLength(1);
    socket.push('ms:producer-closed', { producerId: 'v9' });
    expect(ended).toEqual(['v9']);
    expect(tracks.has('v9')).toBe(false);
  });

  test('publish sends the source with the track; takeover is only sent when asked for', async () => {
    const { mc, socket } = setup();
    await mc.join();
    await mc.publish({ kind: 'video', readyState: 'live' }, 'video');
    await mc.publish({ kind: 'audio', readyState: 'live' }, 'audio', { takeover: true });
    const produced = socket.sent.filter((s) => s.ev === 'ms:produce').map((s) => s.payload.appData);
    expect(produced).toEqual([{ source: 'video' }, { source: 'audio', takeover: true }]);
    expect(socket.sent.filter((s) => s.ev === 'ms:create-transport' && s.payload.direction === 'send')).toHaveLength(1);
    expect(mc.isPublishing('video')).toBe(true);
  });

  test('"publishing elsewhere" from the server reaches the caller as an error with that code', async () => {
    const { mc } = setup({ 'ms:produce': () => ({ error: 'publishing-elsewhere' }) });
    await mc.join();
    await expect(mc.publish({ kind: 'video', readyState: 'live' }, 'video')).rejects.toMatchObject({ code: 'publishing-elsewhere' });
    expect(mc.isPublishing('video')).toBe(false);
  });

  test('another device took over: local producers close and the page is told', async () => {
    const { mc, socket, replaced } = setup();
    await mc.join();
    await mc.publish({ kind: 'video', readyState: 'live' }, 'video');
    socket.push('ms:publisher-replaced', { roomId: 'room-1' });
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(mc.isPublishing('video')).toBe(false);
  });

  test('after a reconnect: old remote tracks end, the room is joined again, live media is re-played and my camera is re-sent', async () => {
    const { srv, mc, socket, tracks, ended } = setup();
    srv.live.push({ producerId: 'v1', userId: 'u-host', handle: 'Kim', source: 'video', kind: 'video' });
    await mc.join();
    const cam = { kind: 'video', readyState: 'live' };
    await mc.publish(cam, 'video');
    socket.sent.length = 0;
    socket.push('connect');
    await vi.waitFor(() => expect(socket.sent.some((s) => s.ev === 'ms:produce')).toBe(true));
    expect(ended).toEqual(['v1']);
    expect(socket.sent[0].ev).toBe('ms:join');
    expect(tracks.has('v1')).toBe(true);
    expect(devices).toHaveLength(2); // a fresh Device: the server forgot the old transports
    expect(socket.sent.find((s) => s.ev === 'ms:produce').payload.appData).toEqual({ source: 'video' });
  });

  test('a request the server never answers fails instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const { mc } = setup({ 'ms:join': undefined });
      const p = mc.join();
      const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  test('leave tells the server, stops listening, and ignores anything announced afterwards', async () => {
    const { mc, socket, tracks } = setup();
    await mc.join();
    await mc.leave();
    expect(socket.sent.at(-1).ev).toBe('ms:leave');
    expect(socket.count('ms:new-producer')).toBe(0);
    socket.push('ms:new-producer', { producerId: 'v5', userId: 'u', handle: 'x', source: 'video', kind: 'video' });
    await flush();
    expect(tracks.size).toBe(0);
  });
});
