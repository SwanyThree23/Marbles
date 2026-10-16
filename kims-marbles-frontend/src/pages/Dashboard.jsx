// Dashboard: what I've actually done (counted by the server), badges, recent activity,
// the weekly challenge, game bests and saved listing templates.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { money } from '../lib/learnData';
import { useToast } from '../components/Toast';

const STATS = [
  ['activeListings', 'Active listings'], ['offersSent', 'Offers sent'], ['posts', 'Posts'],
  ['battles', 'Battles'], ['roomsHosted', 'Streams hosted'], ['collectionCount', 'Marbles owned'],
];

export default function Dashboard() {
  const toast = useToast();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [badges, setBadges] = useState([]);
  const [activity, setActivity] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [dash, ach, act, tpl] = await Promise.all([
        apiFetch('/api/dashboard'), apiFetch('/api/achievements'), apiFetch('/api/activity?limit=20'), apiFetch('/api/templates'),
      ]);
      setD(dash); setBadges(ach); setActivity(act); setTemplates(tpl);
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function del(t) {
    try { await apiFetch(`/api/templates/${t.id}`, { method: 'DELETE' }); setTemplates((l) => l.filter((x) => x.id !== t.id)); toast(`Template "${t.name}" deleted`); } catch (e) { toast(e.message); }
  }

  if (error) return <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>;
  if (!d) return <p className="muted">Loading your dashboard…</p>;
  const entries = d.challenge.entries;
  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Your Numbers</span>
          <h1>Dashboard</h1>
        </div>
      </div>
      <h2 style={{ fontSize: 24, marginBottom: 10 }}>At a glance</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: 20 }}>
        {STATS.map(([k, label]) => (
          <div key={k} className="card stat-card stack" style={{ gap: 2 }}>
            <strong className="mono" style={{ fontSize: 28, color: 'var(--accent-text)' }}>{d.stats[k]}</strong>
            <span className="muted">{label}</span>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', marginBottom: 20 }}>
        <div className="card stack">
          <h3 style={{ fontSize: 20 }}>🏅 Weekly challenge</h3>
          <p style={{ margin: 0 }}>Post to the feed with <strong>{d.challenge.tag}</strong> to enter.</p>
          <span className="muted">{entries === 0 ? 'No entries yet.' : `${entries} ${entries === 1 ? 'entry' : 'entries'} so far.`}</span>
        </div>
        <div className="card stack">
          <h3 style={{ fontSize: 20 }}>🎮 Games</h3>
          <span>Marble Trivia best: <strong>{d.games.trivia.best}</strong> <span className="muted">({d.games.trivia.plays} plays)</span></span>
          <span>Speed ID best: <strong>{d.games.speed.best}</strong> <span className="muted">({d.games.speed.plays} plays)</span></span>
        </div>
      </div>

      <h2 style={{ fontSize: 24, marginBottom: 4 }}>Badges</h2>
      <p className="muted" style={{ marginTop: 0 }}>{d.achievements.unlocked} of {d.achievements.total} unlocked</p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', marginBottom: 20 }}>
        {badges.map((b) => (
          <div key={b.key} className={`card badge-card${b.unlocked ? ' unlocked' : ''}`} style={{ opacity: b.unlocked ? 1 : 0.55 }}>
            <div style={{ fontSize: 28 }} aria-hidden="true">{b.icon}</div>
            <strong>{b.name}</strong>
            <div className="muted" style={{ fontSize: 13 }}>{b.unlocked ? '✓ Unlocked' : b.description}</div>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        <div className="card stack">
          <h3 style={{ fontSize: 20 }}>Recent activity</h3>
          {activity.length ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {activity.map((a) => <li key={a.seq}>{a.text} <span className="muted" style={{ fontSize: 12 }}>{new Date(a.created_at).toLocaleDateString()}</span></li>)}
            </ul>
          ) : <span className="muted">Nothing yet. List a marble, post, or go live.</span>}
        </div>
        <div className="card stack">
          <h3 style={{ fontSize: 20 }}>Saved listing templates</h3>
          {templates.length ? templates.map((t) => (
            <div key={t.id} className="template-row row" style={{ justifyContent: 'space-between' }}>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.name} <span className="muted mono">{t.type === 'trade' ? 'trade' : money(t.price_cents)}</span></span>
              <span className="row">
                <button onClick={() => navigate(`/market?template=${t.id}`)}>Use</button>
                <button className="danger-btn" onClick={() => del(t)}>Delete</button>
              </span>
            </div>
          )) : <span className="muted">Save a listing as a template from the marketplace form to reuse it here.</span>}
        </div>
      </div>
    </section>
  );
}
