// My marbles (self-reported values) and the public collectors leaderboard.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { MARBLE_ICONS, money, parsePriceToCents } from '../lib/learnData';
import { useToast } from '../components/Toast';

export default function Collection() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [leaders, setLeaders] = useState([]);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(MARBLE_ICONS[0]);
  const [value, setValue] = useState('');
  const [formErr, setFormErr] = useState(null);

  const load = useCallback(async () => {
    try { setError(null); setItems(await apiFetch('/api/collection')); } catch (e) { setError(e.message); }
    apiFetch('/api/collection/leaderboard').then(setLeaders).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setFormErr(null);
    if (!name.trim()) return setFormErr('Give your marble a name');
    const cents = value.trim() === '' ? 0 : parsePriceToCents(value);
    if (cents === null) return setFormErr('Enter a value like 25 or 25.50');
    try {
      await apiFetch('/api/collection', { method: 'POST', body: JSON.stringify({ name: name.trim(), icon, estValueCents: cents }) });
      setName(''); setValue('');
      toast(`${name.trim()} added to your collection`);
      load();
    } catch (err) { setFormErr(err.message); }
  }
  async function remove(it) {
    if (!window.confirm(`Remove "${it.name}" from your collection?`)) return;
    try { await apiFetch(`/api/collection/${it.id}`, { method: 'DELETE' }); setItems((l) => l.filter((x) => x.id !== it.id)); } catch (err) { toast(err.message); }
  }
  const total = (items || []).reduce((s, x) => s + Number(x.est_value_cents || 0), 0);

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Your Vault</span>
          <h1>Collection</h1>
          <p className="muted">{items ? `${items.length} marble${items.length === 1 ? '' : 's'} · est. ${money(total)} (your own estimates)` : ' '}</p>
        </div>
      </div>
      <form className="card row" onSubmit={add} style={{ marginBottom: 16 }}>
        <select aria-label="Icon" value={icon} onChange={(e) => setIcon(e.target.value)} style={{ width: 70 }}>
          {MARBLE_ICONS.map((i) => <option key={i}>{i}</option>)}
        </select>
        <input aria-label="Marble name" placeholder="Marble name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 2, minWidth: 140 }} />
        <input aria-label="Estimated value ($)" placeholder="Est. value ($)" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} style={{ flex: 1, minWidth: 100 }} />
        <button type="submit" className="primary-btn">＋ Add</button>
        {formErr && <p className="error" role="alert" style={{ width: '100%', margin: 0 }}>{formErr}</p>}
      </form>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {error ? <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>
            : items === null ? <p className="muted">Loading…</p>
              : items.length === 0 ? <div className="empty-state">Your collection is empty. Add your first marble above.</div>
                : (
                  <div className="grid">
                    {items.map((it) => (
                      <div key={it.id} className="card stack" style={{ gap: 4 }}>
                        <span style={{ fontSize: 34 }} aria-hidden="true">{it.icon}</span>
                        <strong>{it.name}</strong>
                        <span className="mono" style={{ color: 'var(--accent-text)' }}>{money(it.est_value_cents)}</span>
                        <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => remove(it)} aria-label={`Remove ${it.name}`}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
        </div>
        <aside className="card" style={{ width: 230, maxWidth: '100%' }}>
          <h3 style={{ fontSize: 20, color: 'var(--accent-text)' }}>🏆 Top Vaults</h3>
          {leaders.length ? leaders.map((r, i) => <div key={r.handle} className="row" style={{ justifyContent: 'space-between' }}><span>#{i + 1} {r.handle}</span><span className="mono">{money(r.total_value_cents)}</span></div>)
            : <p className="muted">No collections yet.</p>}
        </aside>
      </div>
    </section>
  );
}
