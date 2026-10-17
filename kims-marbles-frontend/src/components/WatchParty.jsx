// Watch party: the host plays a YouTube video for the whole room and everyone stays at the
// same second. The server keeps the room's clock (position, playing, as of when). The host's
// play / pause / from-the-start carry the host player's real position, and while playing the
// host sends a heartbeat every few seconds. Each viewer's player is compared with the clock
// whenever it reports its time and nudged back if it is more than 1.5 s off, so a late joiner
// starts where everyone is and a viewer who buffered catches up. Anyone can suggest videos.
// Talks to YouTube's embed through postMessage only: no third-party script on our page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import {
  parseYoutubeId, embedUrl, playerCommand, commandsFor, PLAYER_ORIGIN, createClock, correction, readPlayerMessage, playerError, LISTEN,
} from '../lib/youtube';

export const HEARTBEAT_MS = 5000;
const CORRECT_EVERY_MS = 2000; // after a correction, let the player settle before judging again

export default function WatchParty({ room, isHost, socket, panelOpen, onClosePanel }) {
  const [video, setVideo] = useState(null);   // { youtubeId, title }
  const [hidden, setHidden] = useState(false);
  const [queue, setQueue] = useState([]);
  const [input, setInput] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState(null);
  const [playerProblem, setPlayerProblem] = useState(null);
  const frame = useRef(null);
  const clock = useRef(createClock());
  const player = useRef({});        // what the player last told us (YouTube sends partial updates)
  const lastFix = useRef(0);

  const post = useCallback((commands) => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    for (const c of commands) w.postMessage(JSON.stringify(c), PLAYER_ORIGIN);
  }, []);
  // bring this player to where the room is now
  const align = useCallback((force = false) => {
    if (isHost) return;
    if (!force && Date.now() - lastFix.current < CORRECT_EVERY_MS) return;
    const cmds = correction(clock.current.now(), player.current);
    if (cmds.length) { lastFix.current = Date.now(); post(cmds); }
  }, [isHost, post]);

  const loadQueue = useCallback(() => apiFetch(`/api/rooms/${room.id}/watchparty`).then((r) => {
    setQueue(r.queue || []);
    return r;
  }).catch(() => null), [room.id]);

  // what is playing when I arrive, and where it is now
  useEffect(() => {
    loadQueue().then((r) => {
      const s = r?.state;
      if (!s?.youtube_id) return;
      clock.current.set({ position: s.position ?? 0, playing: s.playing });
      setVideo({ youtubeId: s.youtube_id, title: s.title });
    });
  }, [loadQueue]);

  // messages from the player
  useEffect(() => {
    function onMessage(e) {
      if (e.origin !== PLAYER_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const m = readPlayerMessage(e.data);
      if (!m) return;
      if (m.event === 'onError') { setPlayerProblem(playerError(m.info)); return; }
      if ((m.event === 'infoDelivery' || m.event === 'initialDelivery') && m.info && typeof m.info === 'object') {
        player.current = { ...player.current, ...m.info };
        if (m.info.currentTime !== undefined || m.info.playerState !== undefined) align();
      }
      if (m.event === 'onReady') align(true);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [align]);

  // room events
  useEffect(() => {
    if (!socket) return undefined;
    const mine = (m) => m && m.roomId === room.id;
    const onLoad = (m) => {
      if (!mine(m) || !parseYoutubeId(m.youtubeId)) return;
      clock.current.set({ position: 0, playing: true });
      player.current = {};
      setPlayerProblem(null);
      setVideo({ youtubeId: m.youtubeId, title: m.title || '' });
      setHidden(false);
    };
    const onControl = (m) => {
      if (!mine(m)) return;
      const position = m.position ?? 0;
      clock.current.set({ position, playing: m.playing ?? m.action !== 'pause' });
      post(commandsFor(m.action, position));
      lastFix.current = Date.now();
    };
    const onSync = (m) => { if (mine(m)) { clock.current.set({ position: m.position, playing: m.playing }); align(); } };
    socket.on('watchparty:load', onLoad);
    socket.on('watchparty:control', onControl);
    socket.on('watchparty:sync', onSync);
    return () => { socket.off('watchparty:load', onLoad); socket.off('watchparty:control', onControl); socket.off('watchparty:sync', onSync); };
  }, [socket, room.id, post, align]);

  // host heartbeat: the host's real position, while playing
  useEffect(() => {
    if (!isHost || !video || !socket) return undefined;
    const t = setInterval(() => {
      const p = player.current;
      if (p.playerState === 1 && typeof p.currentTime === 'number') {
        socket.emit('watchparty:sync', { roomId: room.id, position: p.currentTime });
      }
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [isHost, video, socket, room.id]);

  useEffect(() => { if (panelOpen) loadQueue(); }, [panelOpen, loadQueue]);

  // the player only talks once told someone is listening; repeat until it is ready
  function onFrameLoad() {
    let tries = 0;
    const say = () => {
      if (!frame.current?.contentWindow || player.current.ready || tries++ > 20) return;
      frame.current.contentWindow.postMessage(LISTEN, PLAYER_ORIGIN);
      setTimeout(say, 500);
    };
    say();
  }
  useEffect(() => {
    function ready(e) { if (e.source === frame.current?.contentWindow && readPlayerMessage(e.data)?.event === 'onReady') player.current.ready = true; }
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, []);

  async function playForEveryone(youtubeId, t) {
    setErr(null);
    try {
      await apiFetch(`/api/rooms/${room.id}/watchparty/load`, { method: 'POST', body: JSON.stringify({ youtubeId, title: t }) });
      socket.emit('watchparty:load', { roomId: room.id, youtubeId, title: t });
      clock.current.set({ position: 0, playing: true });
      player.current = {};
      setPlayerProblem(null);
      setVideo({ youtubeId, title: t });
      setHidden(false);
      setInput(''); setTitle('');
    } catch (e) { setErr(e.message); }
  }
  async function suggest() {
    setErr(null);
    const id = parseYoutubeId(input);
    if (!id) return setErr('Paste a YouTube link (or an 11-character video id)');
    if (isHost) return playForEveryone(id, title.trim());
    try {
      await apiFetch(`/api/rooms/${room.id}/watchparty/queue`, { method: 'POST', body: JSON.stringify({ youtubeId: id, title: title.trim() }) });
      setInput(''); setTitle('');
      loadQueue();
    } catch (e) { setErr(e.message); }
  }
  // the host's own player position is the truth for everyone
  function control(action) {
    const position = action === 'restart' ? 0 : (player.current.currentTime ?? clock.current.now().position);
    socket.emit('watchparty:control', { roomId: room.id, action, position });
    clock.current.set({ position, playing: action !== 'pause' });
    post(playerCommand(action));
  }

  return (
    <>
      {video && !hidden && (
        <div className="wp-player card" style={{ margin: '8px 12px 0', padding: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📺 {video.title || 'Watch party'}</span>
            <span className="row" style={{ gap: 4 }}>
              {isHost && (
                <>
                  <button title="Play for everyone" onClick={() => control('play')}>▶</button>
                  <button title="Pause for everyone" onClick={() => control('pause')}>⏸</button>
                  <button title="From the start for everyone" onClick={() => control('restart')}>⏮</button>
                </>
              )}
              <button className="link-btn" onClick={() => setHidden(true)}>Hide</button>
            </span>
          </div>
          {playerProblem && <p className="error" role="alert" style={{ margin: '0 0 6px' }}>{playerProblem}</p>}
          <div style={{ position: 'relative', paddingTop: '56.25%' }}>
            <iframe ref={frame} key={video.youtubeId} title={`Watch party: ${video.title || video.youtubeId}`} src={embedUrl(video.youtubeId)}
              onLoad={onFrameLoad}
              allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>Starts muted: tap the video to turn the sound on.{isHost ? '' : ' It stays in step with the host.'}</span>
        </div>
      )}
      {video && hidden && (
        <button className="link-btn" style={{ margin: '8px 12px 0' }} onClick={() => setHidden(false)}>📺 Show the watch party</button>
      )}
      {panelOpen && (
        <div className="stack wp-panel" style={{ padding: 8, gap: 6, borderBottom: '1px solid var(--line)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>📺 Watch party</strong>
            <button className="link-btn" onClick={onClosePanel}>Close</button>
          </div>
          <input aria-label="YouTube link" placeholder="YouTube link" value={input} onChange={(e) => setInput(e.target.value)} />
          <input aria-label="Video title (optional)" placeholder="Title (optional)" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className="primary-btn" onClick={suggest}>{isHost ? 'Play for everyone' : 'Suggest to the host'}</button>
          {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}
          {queue.length > 0 && <span className="muted" style={{ fontSize: 13 }}>Suggested</span>}
          {queue.map((q) => (
            <div key={q.id} className="row wp-queue-item" style={{ justifyContent: 'space-between' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.title || q.youtube_id}</span>
              {isHost && <button onClick={() => playForEveryone(q.youtube_id, q.title)}>Play</button>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
