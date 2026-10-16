// The live room: everyone on stage as tiles, chat with the host's moderation, reactions, host
// controls (layout, mute/camera for a guest), screen share, camera flip, tips, and two-device
// handling (a second device of the same person becomes a remote control unless it takes over).
//
// Real-time runs over the per-device user socket; media over the SFU via mediaClient.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import { apiFetch } from '../lib/api';
import { startUserSocket, getUserSocket } from '../lib/userSocket';
import { fetchIceConfig } from '../lib/ice';
import { createMediaClient } from '../lib/mediaClient';
import { createCameraSwitcher, shouldMirror } from '../lib/cameraSwitch';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';

const REACTIONS = ['🔥', '❤️', '👏', '😮'];
const TIP_AMOUNTS = [200, 500, 1000, 2000];
const MAX_CHAT = 200;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// injectable for tests
export const deps = {
  Device,
  mediaDevices: () => navigator.mediaDevices,
  createMediaClient,
};

export default function LiveRoom({ room: initialRoom, onLeave }) {
  const { user } = useAuth();
  const [room, setRoom] = useState(initialRoom);
  const isHost = user?.id === room.host_id;
  const [status, setStatus] = useState('connecting'); // connecting | live | reconnecting | ended
  const [mode, setMode] = useState('stage');          // stage | controller | watching
  const [notice, setNotice] = useState(null);
  const [state, setState] = useState({ version: -1, layout: 'grid', muted: {}, cameraOff: {} });
  const [remote, setRemote] = useState({});           // producerId -> { userId, handle, source, kind, track }
  const [local, setLocal] = useState({ video: null, audio: null, screen: null, mirror: true });
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [canFlip, setCanFlip] = useState(false);
  const [chat, setChat] = useState([]);
  const [text, setText] = useState('');
  const [floats, setFloats] = useState([]);
  const [flags, setFlags] = useState([]);
  const [showFlags, setShowFlags] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState(null);
  const mc = useRef(null);
  const switcher = useRef(null);
  const localRef = useRef(local);
  localRef.current = local;
  const listEnd = useRef(null);

  const socket = useMemo(() => { startUserSocket(); return getUserSocket(); }, []);

  const addSystem = useCallback((t) => setChat((c) => [...c.slice(-MAX_CHAT + 1), { id: newId(), system: true, text: t }]), []);

  // ---- open camera + mic and send them ----
  const startPublishing = useCallback(async ({ takeover = false } = {}) => {
    const md = deps.mediaDevices();
    let stream;
    try {
      stream = await md.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    } catch (err) {
      setMode('watching');
      setNotice(`Camera and microphone are not available (${err?.name || 'error'}), so you are watching. Check your browser's permissions to join on stage.`);
      return;
    }
    const video = stream.getVideoTracks()[0] || null;
    const audio = stream.getAudioTracks()[0] || null;
    try {
      if (video) await mc.current.publish(video, 'video', { takeover });
      if (audio) await mc.current.publish(audio, 'audio', { takeover });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      if (err.code === 'publishing-elsewhere') {
        setMode('controller');
        setNotice("You're already live from another device. This one works as a remote control.");
        return;
      }
      setMode('watching');
      setNotice(`Could not send your camera: ${err.message}`);
      return;
    }
    const facing = video?.getSettings?.().facingMode;
    setLocal((l) => ({ ...l, video, audio, mirror: shouldMirror(facing) }));
    setMode('stage');
    setNotice(null);
    setMicOn(true); setCamOn(true);
    switcher.current = createCameraSwitcher({
      mediaDevices: md,
      replaceTrack: (t) => mc.current.replaceTrack('video', t),
      onTrack: (t, { mirror }) => setLocal((l) => ({ ...l, video: t, mirror })),
    });
    if (video) switcher.current.start(video);
  }, []);

  const stopLocal = useCallback(() => {
    const l = localRef.current;
    [l.video, l.audio, l.screen].forEach((t) => { try { t?.stop(); } catch (_e) { /* stopped */ } });
    setLocal({ video: null, audio: null, screen: null, mirror: true });
  }, []);

  // ---- connect ----
  useEffect(() => {
    if (!socket) return undefined;
    let gone = false;
    const roomId = room.id;

    const onState = (s) => { if (s.roomId === roomId) setState((prev) => (s.version >= prev.version ? s : prev)); };
    const onChat = (m) => { if (m.roomId === roomId) setChat((c) => [...c.slice(-MAX_CHAT + 1), m]); };
    const onBlocked = (m) => { if (m.roomId === roomId) addSystem(`🛡️ ${m.reason}. Your message was not sent.`); };
    const onThrottled = (m) => { if (m.roomId === roomId) addSystem(`Slow down: you can chat again in ${Math.ceil((m.retryMs || 1000) / 1000)}s.`); };
    const onReaction = (r) => {
      if (r.roomId !== roomId) return;
      const id = newId();
      setFloats((f) => [...f.slice(-20), { id, emoji: r.emoji, left: 10 + Math.random() * 75 }]);
      setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1700);
    };
    const onFlagged = (f) => { if (f.roomId === roomId) setFlags((l) => [f, ...l].slice(0, 100)); };
    const onEnded = (e) => { if (e.roomId === roomId) { setStatus('ended'); stopLocal(); mc.current?.leave(); } };
    const onDisconnect = () => { if (!gone) setStatus((s) => (s === 'ended' ? s : 'reconnecting')); };
    const onConnect = () => { socket.emit('room:join', { roomId }); setStatus((s) => (s === 'reconnecting' ? 'live' : s)); };

    socket.on('room:state', onState);
    socket.on('room:chat', onChat);
    socket.on('room:chat:blocked', onBlocked);
    socket.on('room:chat:throttled', onThrottled);
    socket.on('room:reaction', onReaction);
    socket.on('moderation:flagged', onFlagged);
    socket.on('room:ended', onEnded);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);

    mc.current = deps.createMediaClient({
      socket, roomId, Device: deps.Device, getIceConfig: fetchIceConfig,
      onTrack: (info, track) => setRemote((r) => ({ ...r, [info.producerId]: { ...info, track } })),
      onTrackEnded: (producerId) => setRemote((r) => { const n = { ...r }; delete n[producerId]; return n; }),
      onReplaced: () => {
        stopLocal();
        setMode('controller');
        setNotice('You went live from another device. This one is now a remote control.');
      },
      onError: (err) => addSystem(`Media problem: ${err.message}`),
    });

    (async () => {
      let watchOnly = false;
      try {
        if (!isHost) {
          try {
            await apiFetch(`/api/rooms/${roomId}/join`, { method: 'POST' });
          } catch (err) {
            if (err.status === 409 && /full/i.test(err.message)) {
              watchOnly = true;
              setMode('watching');
              setNotice('The stage is full, so you are watching.');
            } else if (err.status === 409) { setStatus('ended'); return; } else throw err;
          }
        }
        if (gone) return;
        if (socket.connected) socket.emit('room:join', { roomId });
        await mc.current.join();
        if (gone) return;
        setStatus('live');
        if (!watchOnly) await startPublishing();
      } catch (err) {
        if (!gone) { setStatus('live'); setMode('watching'); setNotice(`Could not join the stage: ${err.message}`); }
      }
    })();

    return () => {
      gone = true;
      socket.off('room:state', onState);
      socket.off('room:chat', onChat);
      socket.off('room:chat:blocked', onBlocked);
      socket.off('room:chat:throttled', onThrottled);
      socket.off('room:reaction', onReaction);
      socket.off('moderation:flagged', onFlagged);
      socket.off('room:ended', onEnded);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      socket.emit('room:leave', { roomId });
      mc.current?.leave();
      stopLocal();
    };
  }, [room.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // camera flip availability
  useEffect(() => {
    if (!local.video || !switcher.current) { setCanFlip(false); return undefined; }
    return switcher.current.watch(setCanFlip);
  }, [local.video]);

  // the host muted me / turned my camera off: obey it on this device
  const hostMutedMe = !!(user && state.muted[user.id]) && !isHost;
  const hostCamOffMe = !!(user && state.cameraOff[user.id]) && !isHost;
  useEffect(() => { if (local.audio) local.audio.enabled = micOn && !hostMutedMe; }, [local.audio, micOn, hostMutedMe]);
  useEffect(() => { if (local.video) local.video.enabled = camOn && !hostCamOffMe; }, [local.video, camOn, hostCamOffMe]);

  useEffect(() => { listEnd.current?.scrollIntoView?.({ block: 'end' }); }, [chat]);

  // ---- actions ----
  function sendChat(e) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || !socket) return;
    socket.emit('room:chat', { roomId: room.id, text: body.slice(0, 500) });
    setText('');
  }
  const react = (emoji) => socket?.emit('room:reaction', { roomId: room.id, emoji });
  const command = (cmd) => new Promise((resolve) => {
    socket.emit('room:command', { roomId: room.id, commandId: newId(), ...cmd }, (r) => {
      if (!r?.ok) addSystem(r?.error || 'That did not work');
      resolve(r);
    });
  });

  async function flip() {
    const r = await switcher.current?.switchCamera();
    if (r && !r.ok && r.error !== 'busy') addSystem(r.restored ? 'Could not switch cameras; kept the one you had.' : 'Your camera stopped. Turn it back on to continue.');
  }

  async function toggleScreen() {
    if (local.screen) {
      local.screen.stop();
      await mc.current.unpublish('screen');
      setLocal((l) => ({ ...l, screen: null }));
      socket.emit('room:screen-share', { roomId: room.id, active: false });
      return;
    }
    try {
      const s = await deps.mediaDevices().getDisplayMedia({ video: true, audio: false });
      const track = s.getVideoTracks()[0];
      await mc.current.publish(track, 'screen');
      track.addEventListener('ended', () => { mc.current?.unpublish('screen'); setLocal((l) => ({ ...l, screen: null })); socket.emit('room:screen-share', { roomId: room.id, active: false }); });
      setLocal((l) => ({ ...l, screen: track }));
      socket.emit('room:screen-share', { roomId: room.id, active: true });
    } catch (err) {
      if (err?.name !== 'NotAllowedError') addSystem(`Screen share failed: ${err.message}`);
    }
  }

  async function takeOver() {
    setNotice('Switching your camera to this device…');
    await startPublishing({ takeover: true });
  }

  async function invite() {
    try {
      const r = await apiFetch(`/api/rooms/${room.id}/invite`, { method: 'POST' });
      const url = r.url.startsWith('http') ? r.url : `${window.location.origin}${r.url}`;
      setInviteUrl(url);
      try { await navigator.clipboard?.writeText(url); } catch (_e) { /* shown on screen anyway */ }
    } catch (err) { addSystem(err.message); }
  }

  async function leave() {
    if (isHost && status !== 'ended') {
      if (!window.confirm('End the stream for everyone?')) return;
      try { setRoom(await apiFetch(`/api/rooms/${room.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'ended' }) })); } catch (err) { addSystem(err.message); return; }
    } else if (!isHost) {
      apiFetch(`/api/rooms/${room.id}/leave`, { method: 'POST' }).catch(() => {});
    }
    onLeave?.();
  }

  // ---- tiles ----
  const tiles = useMemo(() => {
    const byUser = new Map();
    const tile = (userId, handle) => {
      if (!byUser.has(userId)) byUser.set(userId, { userId, handle, video: null, audio: null, screen: null, self: false });
      return byUser.get(userId);
    };
    if (mode === 'stage' && (local.video || local.audio)) {
      const me = tile(user.id, user.handle);
      Object.assign(me, { video: local.video, audio: null, screen: local.screen, self: true, mirror: local.mirror });
    }
    for (const r of Object.values(remote)) {
      if (r.userId === user?.id && mode === 'stage') continue; // never show/hear my own other device twice
      const t = tile(r.userId, r.handle);
      if (r.source === 'screen') t.screen = r.track; else if (r.kind === 'audio') t.audio = r.track; else t.video = r.track;
    }
    return [...byUser.values()].sort((a, b) => (b.userId === room.host_id) - (a.userId === room.host_id));
  }, [remote, local, mode, user, room.host_id]);

  if (status === 'ended') {
    return (
      <div className="live-room" role="dialog" aria-label={room.title}>
        <div className="lr-header"><span className="lr-title">{room.title}</span></div>
        <div className="empty-state" style={{ margin: 24 }}>
          <p>This stream has ended.</p>
          <button className="primary-btn" onClick={() => onLeave?.()}>Back to Panels</button>
        </div>
      </div>
    );
  }

  return (
    <div className="live-room" role="dialog" aria-label={room.title}>
      <div className="lr-header">
        <span className="tag">● Live</span>
        <span className="lr-title">{room.title} <span className="muted" style={{ fontWeight: 400 }}>· {room.host_handle}</span></span>
        {isHost && (
          <button className="lr-btn" title="Messages blocked by your chat rules" aria-expanded={showFlags} onClick={() => setShowFlags(!showFlags)} style={{ width: 'auto', borderRadius: 23, padding: '0 12px' }}>
            🛡️ <span className="mono">{flags.length}</span>
          </button>
        )}
        <button className="lr-btn leave" onClick={leave}>{isHost ? 'End stream' : 'Leave'}</button>
      </div>
      {status === 'reconnecting' && <div role="status" className="lc-flag" style={{ margin: 8 }}>Connection lost. Reconnecting…</div>}
      {notice && (
        <div role="status" className="card" style={{ margin: 8, padding: 10 }}>
          {notice}
          {mode === 'controller' && <> <button onClick={takeOver}>Use this device's camera instead</button></>}
        </div>
      )}
      {inviteUrl && (
        <div role="status" className="card" style={{ margin: 8, padding: 10, overflowWrap: 'anywhere' }}>
          One-time invite link (valid 2 hours): <span className="mono">{inviteUrl}</span> <button className="link-btn" onClick={() => setInviteUrl(null)}>Hide</button>
        </div>
      )}
      <div className="lr-body">
        <div className={`lr-stage${state.layout === 'spotlight' ? ' spotlight' : ''}`} data-layout={state.layout}>
          {tiles.length === 0 && <div className="empty-state" style={{ gridColumn: '1 / -1' }}>{status === 'connecting' ? 'Connecting…' : 'Nobody is on stage yet.'}</div>}
          {tiles.map((t) => (
            <Tile key={t.userId} t={t} isHostTile={t.userId === room.host_id} muted={!!state.muted[t.userId] || (t.self && !micOn)} camOff={!!state.cameraOff[t.userId] || (t.self && !camOn)}
              hostControls={isHost && !t.self && t.userId !== user.id}
              onMute={() => command({ type: 'mute', targetUserId: t.userId, value: !state.muted[t.userId] })}
              onCamera={() => command({ type: 'camera', targetUserId: t.userId, value: !state.cameraOff[t.userId] })} />
          ))}
          {floats.map((f) => <span key={f.id} className="lc-float" style={{ left: `${f.left}%` }} aria-hidden="true">{f.emoji}</span>)}
        </div>
        <div className="lr-side">
          {isHost && showFlags && (
            <div className="stack" style={{ padding: 8, gap: 6, maxHeight: '40%', overflowY: 'auto', borderBottom: '1px solid var(--line)' }}>
              {flags.length === 0 ? <span className="muted">Nothing blocked yet.</span> : flags.map((f, i) => (
                <div key={`${f.at}-${i}`} className="lc-flag"><b>{f.handle}</b>: “{f.text}” — blocked: {f.word}</div>
              ))}
            </div>
          )}
          <div className="lc-list" aria-live="polite">
            {chat.map((m) => (m.system
              ? <div key={m.id} className="lc-msg muted" role="status">{m.text}</div>
              : <div key={m.id} className="lc-msg"><b>{m.handle}</b>{m.text}</div>))}
            <div ref={listEnd} />
          </div>
          <form className="lc-input" onSubmit={sendChat}>
            <input aria-label="Chat message" placeholder="Say something…" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
            <button type="submit">Send</button>
          </form>
        </div>
      </div>
      <div className="lr-controls">
        {mode === 'stage' && local.audio && (
          <button className={`lr-btn${!micOn || hostMutedMe ? ' off' : ''}`} title={hostMutedMe ? 'The host muted you' : micOn ? 'Mute microphone' : 'Unmute microphone'} aria-pressed={!micOn} disabled={hostMutedMe} onClick={() => setMicOn(!micOn)}>{micOn && !hostMutedMe ? '🎤' : '🔇'}</button>
        )}
        {mode === 'stage' && local.video && (
          <button className={`lr-btn${!camOn || hostCamOffMe ? ' off' : ''}`} title={hostCamOffMe ? 'The host turned your camera off' : camOn ? 'Turn camera off' : 'Turn camera on'} aria-pressed={!camOn} disabled={hostCamOffMe} onClick={() => setCamOn(!camOn)}>📷</button>
        )}
        {mode === 'stage' && canFlip && <button className="lr-btn" title="Switch camera" onClick={flip}>🔄</button>}
        {mode === 'stage' && typeof deps.mediaDevices()?.getDisplayMedia === 'function' && (
          <button className={`lr-btn${local.screen ? ' off' : ''}`} title={local.screen ? 'Stop sharing your screen' : 'Share your screen'} onClick={toggleScreen}>🖥️</button>
        )}
        {REACTIONS.map((e) => <button key={e} className="lr-btn" title={`React ${e}`} onClick={() => react(e)}>{e}</button>)}
        {!isHost && <button className="lr-btn" title="Send a tip" onClick={() => setTipOpen(true)}>💰</button>}
        {isHost && (
          <>
            <button className="lr-btn host-only" title={state.layout === 'grid' ? 'Spotlight layout' : 'Grid layout'} onClick={() => command({ type: 'layout', value: state.layout === 'grid' ? 'spotlight' : 'grid' })}>{state.layout === 'grid' ? '⬛' : '▦'}</button>
            <button className="lr-btn host-only" title="Invite someone on stage" onClick={invite}>🔗</button>
          </>
        )}
      </div>
      {tipOpen && <TipModal room={room} onClose={() => setTipOpen(false)} />}
    </div>
  );
}

function Tile({ t, isHostTile, muted, camOff, hostControls, onMute, onCamera }) {
  const showVideo = t.screen || (t.video && !camOff);
  return (
    <div className={`lr-tile${isHostTile ? ' host' : ''}`} data-user={t.userId} data-self={t.self ? '1' : undefined}>
      {showVideo ? <Video track={t.screen || t.video} mirror={t.self && !t.screen && t.mirror} muted /> : <span aria-hidden="true">🔮</span>}
      {!t.self && t.audio && <Audio track={t.audio} />}
      <span className="lr-tile-label">{isHostTile ? '★ ' : ''}{t.handle}{t.self ? ' (you)' : ''}</span>
      {(muted || camOff) && <span className="lr-tile-badge">{muted ? '🔇' : ''}{camOff ? '📷✕' : ''}</span>}
      {hostControls && (
        <span className="row lr-tile-tools" style={{ position: 'absolute', top: 6, right: 6, gap: 4 }}>
          <button title={muted ? `Unmute ${t.handle}` : `Mute ${t.handle}`} onClick={onMute}>{muted ? '🔈' : '🔇'}</button>
          <button title={camOff ? `Turn ${t.handle}'s camera on` : `Turn ${t.handle}'s camera off`} onClick={onCamera}>📷</button>
        </span>
      )}
    </div>
  );
}

function Video({ track, mirror, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    el.srcObject = new MediaStream([track]);
    el.play?.().catch(() => {});
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={mirror ? 'mirror' : undefined} />;
}

function Audio({ track }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    el.srcObject = new MediaStream([track]);
    el.play?.().catch(() => {});
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

function TipModal({ room, onClose }) {
  const [amount, setAmount] = useState(500);
  const [message, setMessage] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function pay() {
    setBusy(true); setErr(null);
    try {
      const r = await apiFetch('/api/payments/tip', { method: 'POST', body: JSON.stringify({ roomId: room.id, amountCents: amount, message: message.trim() }) });
      if (r.url) window.location.assign(r.url);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="💰 Send a Tip" onClose={onClose}>
      <div className="stack">
        <span className="muted">Goes to {room.host_handle}. Paid securely on Stripe.</span>
        <div className="segmented" role="group" aria-label="Tip amount">
          {TIP_AMOUNTS.map((c) => <button key={c} aria-pressed={amount === c} onClick={() => setAmount(c)}>${c / 100}</button>)}
        </div>
        <input aria-label="Message (optional)" placeholder="Message (optional)" maxLength={280} value={message} onChange={(e) => setMessage(e.target.value)} />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary-btn" onClick={pay} disabled={busy}>Continue to payment</button>
      </div>
    </Modal>
  );
}
