// Panels: who is live, what is scheduled, and Go Live (now or later). Joining a room opens
// /live/:roomId, so a live room has a link that works on any device.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { CATEGORIES } from '../lib/learnData';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';

export default function Panels() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);
  const goLiveOpen = params.get('golive') === '1';

  const load = useCallback(async () => {
    try { setError(null); setRooms(await apiFetch('/api/rooms')); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  async function startScheduled(r) {
    try { await apiFetch(`/api/rooms/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'live' }) }); navigate(`/live/${r.id}`); } catch (e) { toast(e.message); }
  }
  const live = (rooms || []).filter((r) => r.status === 'live');
  const scheduled = (rooms || []).filter((r) => r.status === 'scheduled');

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Live Panels</span>
          <h1>Panels</h1>
          <p className="muted">Live shows, auctions and chats with up to 50 collectors on stage.</p>
        </div>
        <button className="primary-btn" onClick={() => setParams({ golive: '1' })}>● Go Live</button>
      </div>
      {error ? <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>
        : rooms === null ? <p className="muted">Loading…</p> : (
          <>
            <h2 style={{ fontSize: 24, marginBottom: 10 }}>Live now</h2>
            {live.length === 0 ? <div className="empty-state" style={{ marginBottom: 20 }}>Nobody is live right now. Start something!</div> : (
              <div className="grid" style={{ marginBottom: 20 }}>
                {live.map((r) => (
                  <div key={r.id} className="card stack room-card" style={{ gap: 6 }}>
                    <span className="tag" style={{ alignSelf: 'flex-start' }}>● Live · {r.category}</span>
                    <strong>{r.title}</strong>
                    <span className="muted">{r.host_handle} · {r.guest_count}/{r.max_guests} on stage</span>
                    <button className="primary-btn" onClick={() => navigate(`/live/${r.id}`)} aria-label={`Join ${r.title}`}>{r.host_id === user?.id ? 'Return to your stream' : 'Join'}</button>
                  </div>
                ))}
              </div>
            )}
            <h2 style={{ fontSize: 24, marginBottom: 10 }}>Coming up</h2>
            {scheduled.length === 0 ? <p className="muted">Nothing scheduled.</p> : (
              <div className="grid">
                {scheduled.map((r) => (
                  <div key={r.id} className="card stack" style={{ gap: 6 }}>
                    <strong>{r.title}</strong>
                    <span className="muted">{r.host_handle}{r.scheduled_for ? ` · ${new Date(r.scheduled_for).toLocaleString()}` : ''}</span>
                    {r.host_id === user?.id && <button className="primary-btn" onClick={() => startScheduled(r)}>Start now</button>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      {goLiveOpen && <GoLive defaultTitle={`${user?.handle}'s Stream`} onClose={() => setParams({}, { replace: true })} onLive={(room) => navigate(`/live/${room.id}`)} onScheduled={() => { setParams({}, { replace: true }); load(); }} />}
    </section>
  );
}

function GoLive({ defaultTitle, onClose, onLive, onScheduled }) {
  const toast = useToast();
  const [title, setTitle] = useState(defaultTitle);
  const [category, setCategory] = useState('General');
  const [maxGuests, setMaxGuests] = useState(6);
  const [when, setWhen] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create(now) {
    setErr(null);
    if (!title.trim()) return setErr('Give your stream a title');
    if (!now && !when) return setErr('Pick a date and time to schedule it');
    setBusy(true);
    try {
      const body = { title: title.trim(), category, maxGuests: Number(maxGuests), ...(now ? { goLiveNow: true } : { scheduledFor: new Date(when).toISOString() }) };
      const room = await apiFetch('/api/rooms', { method: 'POST', body: JSON.stringify(body) });
      if (now) onLive(room); else { toast('Scheduled'); onScheduled(room); }
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Go Live" onClose={onClose}>
      <div className="stack">
        <label className="stack" style={{ gap: 4 }}>Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="stack" style={{ gap: 4 }}>Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>{['General', 'Auction', ...CATEGORIES].map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="stack" style={{ gap: 4 }}>Guests on stage (max)
          <input type="number" min={1} max={50} value={maxGuests} onChange={(e) => setMaxGuests(e.target.value)} />
        </label>
        <label className="stack" style={{ gap: 4 }}>Schedule for later (optional)
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary-btn" disabled={busy} onClick={() => create(true)}>● Go Live Now</button>
        <button disabled={busy} onClick={() => create(false)}>Schedule</button>
      </div>
    </Modal>
  );
}
