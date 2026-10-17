// Watch party: the host plays a YouTube video for the whole room and controls it (play, pause,
// from the start); anyone can suggest videos for the queue. The video shows above the stage
// and each viewer can hide it on their own screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { parseYoutubeId, embedUrl, playerCommand, PLAYER_ORIGIN } from '../lib/youtube';

export default function WatchParty({ room, isHost, socket, panelOpen, onClosePanel }) {
  const [video, setVideo] = useState(null);   // { youtubeId, title }
  const [hidden, setHidden] = useState(false);
  const [queue, setQueue] = useState([]);
  const [input, setInput] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState(null);
  const frame = useRef(null);

  const send = useCallback((action) => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    for (const c of playerCommand(action)) w.postMessage(JSON.stringify(c), PLAYER_ORIGIN);
  }, []);

  const loadQueue = useCallback(() => apiFetch(`/api/rooms/${room.id}/watchparty`).then((r) => {
    setQueue(r.queue || []);
    return r;
  }).catch(() => null), [room.id]);

  // what is playing when I arrive
  useEffect(() => {
    loadQueue().then((r) => { if (r?.state?.youtube_id) setVideo({ youtubeId: r.state.youtube_id, title: r.state.title }); });
  }, [loadQueue]);

  useEffect(() => {
    if (!socket) return undefined;
    const onLoad = (m) => { if (m.roomId === room.id && parseYoutubeId(m.youtubeId)) { setVideo({ youtubeId: m.youtubeId, title: m.title || '' }); setHidden(false); } };
    const onControl = (m) => { if (m.roomId === room.id) send(m.action); };
    socket.on('watchparty:load', onLoad);
    socket.on('watchparty:control', onControl);
    return () => { socket.off('watchparty:load', onLoad); socket.off('watchparty:control', onControl); };
  }, [socket, room.id, send]);

  useEffect(() => { if (panelOpen) loadQueue(); }, [panelOpen, loadQueue]);

  async function playForEveryone(youtubeId, t) {
    setErr(null);
    try {
      await apiFetch(`/api/rooms/${room.id}/watchparty/load`, { method: 'POST', body: JSON.stringify({ youtubeId, title: t }) });
      socket.emit('watchparty:load', { roomId: room.id, youtubeId, title: t });
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
  function control(action) {
    socket.emit('watchparty:control', { roomId: room.id, action });
    send(action);
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
          <div style={{ position: 'relative', paddingTop: '56.25%' }}>
            <iframe ref={frame} key={video.youtubeId} title={`Watch party: ${video.title || video.youtubeId}`} src={embedUrl(video.youtubeId)}
              allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, borderRadius: 8 }} />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>Starts muted: tap the video to turn the sound on.</span>
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
