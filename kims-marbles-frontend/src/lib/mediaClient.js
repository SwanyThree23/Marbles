// mediaClient.js — one device's audio/video in one live room, over the SFU.
//
// Signalling is the server's ack-style protocol (see server/mediasoup/signaling.js):
//   ms:join -> ms:create-transport -> ms:connect-transport -> ms:produce / ms:consume
//   -> ms:resume-consumer, ms:close-producer, ms:leave
// and pushes ms:new-producer, ms:producer-closed, ms:publisher-replaced.
//
// The server forgets a socket's media when it disconnects, so after a reconnect this client
// joins again from scratch: it drops every remote track (onTrackEnded), re-consumes what is
// live now, and republishes the tracks it was sending. Nothing waits forever: every request
// times out.
//
// The socket and the mediasoup Device class are passed in, so tests can drive this without
// a browser.
export const ACK_TIMEOUT_MS = 10_000;

export class MediaError extends Error {
  constructor(message, code) { super(message); this.code = code || message; }
}

export function createMediaClient({ socket, roomId, Device, getIceConfig = async () => ({ iceServers: [] }), onTrack = () => {}, onTrackEnded = () => {}, onReplaced = () => {}, onError = () => {} }) {
  let device = null;
  let send = null;
  let recv = null;
  let ice = { iceServers: [] };
  let joined = false;
  let closed = false;
  let generation = 0;                // bumps on every (re)join; late answers from an old one are dropped
  const consumers = new Map();       // producerId -> { consumer, info }
  const producers = new Map();       // source -> producer
  const pending = new Set();         // producerIds being consumed

  function ask(event, payload = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new MediaError(`No answer to ${event}`, 'timeout')), ACK_TIMEOUT_MS);
      socket.emit(event, payload, (res) => {
        clearTimeout(t);
        if (!res || res.error) reject(new MediaError(res?.error || `${event} failed`));
        else resolve(res);
      });
    });
  }

  async function makeTransport(direction) {
    const p = await ask('ms:create-transport', { direction });
    const opts = { id: p.id, iceParameters: p.iceParameters, iceCandidates: p.iceCandidates, dtlsParameters: p.dtlsParameters, iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy || 'all' };
    const t = direction === 'send' ? device.createSendTransport(opts) : device.createRecvTransport(opts);
    t.on('connect', ({ dtlsParameters }, cb, eb) => { ask('ms:connect-transport', { transportId: t.id, dtlsParameters }).then(() => cb(), eb); });
    if (direction === 'send') {
      t.on('produce', ({ kind, rtpParameters, appData }, cb, eb) => {
        ask('ms:produce', { transportId: t.id, kind, rtpParameters, appData }).then((r) => cb({ id: r.id }), eb);
      });
    }
    return t;
  }

  async function consume(info) {
    const gen = generation;
    if (!recv || consumers.has(info.producerId) || pending.has(info.producerId)) return;
    pending.add(info.producerId);
    try {
      const r = await ask('ms:consume', { transportId: recv.id, producerId: info.producerId, rtpCapabilities: device.rtpCapabilities });
      if (gen !== generation || closed) return;
      const consumer = await recv.consume({ id: r.id, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters });
      consumers.set(info.producerId, { consumer, info });
      await ask('ms:resume-consumer', { consumerId: consumer.id });
      if (gen !== generation || closed) return;
      onTrack({ producerId: info.producerId, userId: info.userId, handle: info.handle, source: info.source, kind: consumer.kind }, consumer.track);
    } catch (err) {
      if (gen === generation && !closed) onError(err);
    } finally {
      pending.delete(info.producerId);
    }
  }

  function dropRemote(producerId) {
    const c = consumers.get(producerId);
    if (!c) return;
    consumers.delete(producerId);
    try { c.consumer.close(); } catch (_e) { /* already closed */ }
    onTrackEnded(producerId);
  }

  function resetMedia() {
    generation += 1;
    for (const id of [...consumers.keys()]) dropRemote(id);
    for (const p of producers.values()) { try { p.close(); } catch (_e) { /* gone */ } }
    for (const t of [send, recv]) { try { t?.close(); } catch (_e) { /* gone */ } }
    send = null; recv = null; device = null; joined = false;
  }

  // tracks we are sending, so a reconnect can put them back: source -> track
  const sending = new Map();

  async function join() {
    if (closed) throw new MediaError('closed');
    const gen = generation;
    const r = await ask('ms:join', { roomId });
    if (gen !== generation || closed) return;
    device = new Device();
    await device.load({ routerRtpCapabilities: r.rtpCapabilities });
    ice = await getIceConfig();
    recv = await makeTransport('recv');
    joined = true;
    await Promise.all((r.existingProducers || []).map(consume));
  }

  async function publish(track, source, { takeover = false } = {}) {
    if (!joined) throw new MediaError('Not connected to the room yet', 'not-joined');
    if (!device.canProduce(track.kind)) throw new MediaError(`This browser cannot send ${track.kind}`, 'cannot-produce');
    if (!send) send = await makeTransport('send');
    const old = producers.get(source);
    if (old) { await unpublish(source); }
    const producer = await send.produce({ track, appData: { source, ...(takeover ? { takeover: true } : {}) } });
    producers.set(source, producer);
    sending.set(source, track);
    producer.on?.('transportclose', () => producers.delete(source));
    return producer;
  }

  async function unpublish(source) {
    const p = producers.get(source);
    sending.delete(source);
    if (!p) return;
    producers.delete(source);
    try { await ask('ms:close-producer', { producerId: p.id }); } catch (_e) { /* server already dropped it */ }
    try { p.close(); } catch (_e) { /* gone */ }
  }

  async function replaceTrack(source, track) {
    const p = producers.get(source);
    if (!p) throw new MediaError(`Not sending ${source}`, 'not-sending');
    await p.replaceTrack({ track });
    sending.set(source, track);
  }

  const onNewProducer = (info) => { if (joined) consume(info); };
  const onProducerClosed = ({ producerId }) => dropRemote(producerId);
  const onPublisherReplaced = () => {
    for (const p of producers.values()) { try { p.close(); } catch (_e) { /* gone */ } }
    producers.clear();
    sending.clear();
    onReplaced();
  };
  let everConnected = socket.connected;
  const onConnect = async () => {
    if (!everConnected) { everConnected = true; return; }
    if (closed) return;
    const resend = [...sending.entries()];
    resetMedia();
    try {
      await join();
      for (const [source, track] of resend) {
        if (track.readyState !== 'ended') await publish(track, source);
      }
    } catch (err) { if (!closed) onError(err); }
  };

  socket.on('ms:new-producer', onNewProducer);
  socket.on('ms:producer-closed', onProducerClosed);
  socket.on('ms:publisher-replaced', onPublisherReplaced);
  socket.on('connect', onConnect);

  async function leave() {
    if (closed) return;
    closed = true;
    socket.off('ms:new-producer', onNewProducer);
    socket.off('ms:producer-closed', onProducerClosed);
    socket.off('ms:publisher-replaced', onPublisherReplaced);
    socket.off('connect', onConnect);
    sending.clear();
    resetMedia();
    if (socket.connected) socket.emit('ms:leave', {}, () => {});
  }

  return {
    join, publish, unpublish, replaceTrack, leave,
    isPublishing: (source) => producers.has(source),
    get joined() { return joined; },
    get remoteCount() { return consumers.size; },
  };
}
