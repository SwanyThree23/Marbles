// PK-Battles: challenge a collector by handle, answer challenges, gift points to a side while a
// battle is live (scores update live for everyone watching), end it, and the leaderboard.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { getUserSocket } from '../lib/userSocket';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

const GIFTS = [['🌹', 'Rose', 10], ['🔮', 'Crystal', 50], ['👑', 'Crown', 200]];

export default function Battles() {
  const { user } = useAuth();
  const toast = useToast();
  const [mine, setMine] = useState(null);
  const [live, setLive] = useState([]);
  const [leaders, setLeaders] = useState([]);
  const [error, setError] = useState(null);
  const [handle, setHandle] = useState('');
  const [formErr, setFormErr] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [m, l] = await Promise.all([apiFetch('/api/battles?mine=1'), apiFetch('/api/battles')]);
      setMine(m); setLive(l);
    } catch (e) { setError(e.message); }
    apiFetch('/api/battles/leaderboard').then(setLeaders).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // live score updates for every live battle on screen
  const liveIds = live.map((b) => b.id).join(',');
  useEffect(() => {
    const s = getUserSocket();
    if (!s || !liveIds) return undefined;
    const ids = liveIds.split(',');
    const join = () => ids.forEach((battleId) => s.emit('battle:join', { battleId }));
    join();
    s.on('connect', join);
    const onUpdate = (b) => {
      const patch = (list) => list.map((x) => (x.id === b.id ? { ...x, ...b } : x));
      setLive((l) => (b.status === 'live' ? patch(l) : l.filter((x) => x.id !== b.id)));
      setMine((l) => (l ? patch(l) : l));
    };
    s.on('battle:update', onUpdate);
    return () => { s.off('connect', join); s.off('battle:update', onUpdate); ids.forEach((battleId) => s.emit('battle:leave', { battleId })); };
  }, [liveIds]);

  async function challenge(e) {
    e.preventDefault();
    setFormErr(null);
    const h = handle.trim().replace(/^@/, '');
    if (!h) return;
    try {
      const u = await apiFetch(`/api/users/${encodeURIComponent(h)}`);
      await apiFetch('/api/battles', { method: 'POST', body: JSON.stringify({ opponentId: u.id }) });
      setHandle('');
      toast(`Challenge sent to ${u.handle}`);
      load();
    } catch (err) { setFormErr(err.status === 404 ? `No collector called "${h}"` : err.message); }
  }
  const act = (b, path, body) => async () => {
    try { await apiFetch(`/api/battles/${b.id}/${path}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) }); load(); } catch (err) { toast(err.message); }
  };

  const pending = (mine || []).filter((b) => b.status === 'pending');
  const history = (mine || []).filter((b) => b.status === 'ended' || b.status === 'declined').slice(0, 10);
  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Head to Head</span>
          <h1>PK-Battles</h1>
          <p className="muted">Challenge a collector. Viewers gift points to their side; most points wins.</p>
        </div>
      </div>
      <form className="card row" onSubmit={challenge} style={{ marginBottom: 16 }}>
        <input aria-label="Opponent handle" placeholder="Challenge @handle…" value={handle} onChange={(e) => setHandle(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        <button type="submit" className="primary-btn">⚔️ Challenge</button>
        {formErr && <p className="error" role="alert" style={{ width: '100%', margin: 0 }}>{formErr}</p>}
      </form>
      {error && <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>}
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div className="stack" style={{ flex: 1, minWidth: 0 }}>
          {pending.length > 0 && <h2 style={{ fontSize: 22 }}>Waiting for an answer</h2>}
          {pending.map((b) => (
            <div key={b.id} className="card row" style={{ justifyContent: 'space-between' }}>
              <span>{b.challenger_handle} vs {b.opponent_handle}</span>
              {b.opponent_id === user?.id
                ? <span className="row"><button className="primary-btn" onClick={act(b, 'accept')}>Accept</button><button onClick={act(b, 'decline')}>Decline</button></span>
                : <span className="muted">Waiting for {b.opponent_handle}</span>}
            </div>
          ))}
          <h2 style={{ fontSize: 22 }}>Live now</h2>
          {mine === null && !error ? <p className="muted">Loading…</p>
            : live.length === 0 ? <div className="empty-state">No battles are live right now.</div>
              : live.map((b) => <LiveBattle key={b.id} b={b} me={user?.id} gift={(side, g) => act(b, 'gift', { side, giftName: g[1], points: g[2] })()} end={act(b, 'end')} />)}
          {history.length > 0 && <h2 style={{ fontSize: 22 }}>Your recent battles</h2>}
          {history.map((b) => (
            <div key={b.id} className="card row" style={{ justifyContent: 'space-between' }}>
              <span>{b.challenger_handle} {b.challenger_points} – {b.opponent_points} {b.opponent_handle}</span>
              <span className="muted">{b.status === 'declined' ? 'Declined' : b.winner_id ? (b.winner_id === user?.id ? '🏆 You won' : 'Lost') : 'Draw'}</span>
            </div>
          ))}
        </div>
        <aside className="card" style={{ width: 230, maxWidth: '100%' }}>
          <h3 style={{ fontSize: 20, color: 'var(--accent-text)' }}>🏆 Leaderboard</h3>
          {leaders.length ? leaders.map((r, i) => <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}><span>#{i + 1} {r.handle}</span><span className="mono">{r.points.toLocaleString()} pts</span></div>)
            : <p className="muted">No points yet.</p>}
        </aside>
      </div>
    </section>
  );
}

function LiveBattle({ b, me, gift, end }) {
  const total = b.challenger_points + b.opponent_points || 1;
  const fighter = me === b.challenger_id || me === b.opponent_id;
  return (
    <div className="card stack battle-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{b.challenger_handle}</strong><span className="tag">● Live</span><strong>{b.opponent_handle}</strong>
      </div>
      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--panel2)' }} aria-hidden="true">
        <div style={{ width: `${(b.challenger_points / total) * 100}%`, background: 'var(--primary)' }} />
        <div style={{ flex: 1, background: 'var(--accent)' }} />
      </div>
      <div className="row mono" style={{ justifyContent: 'space-between' }}>
        <span data-testid="challenger-points">{b.challenger_points}</span><span data-testid="opponent-points">{b.opponent_points}</span>
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {['challenger', 'opponent'].map((side) => (
          <span key={side} className="row" style={{ gap: 4 }}>
            {GIFTS.map((g) => <button key={g[1]} title={`Gift ${g[1]} (${g[2]} pts) to ${side === 'challenger' ? b.challenger_handle : b.opponent_handle}`} onClick={() => gift(side, g)}>{g[0]}</button>)}
          </span>
        ))}
      </div>
      {fighter && <button className="danger-btn" onClick={end}>End battle</button>}
    </div>
  );
}
