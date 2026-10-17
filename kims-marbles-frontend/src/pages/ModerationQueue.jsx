// Admins only: reports from the community. "Remove" takes a reported listing or post down
// (and marks the report actioned); "Dismiss" closes it without action.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

const REMOVABLE = { listing: (id) => `/api/listings/${id}`, post: (id) => `/api/feed/${id}` };

export default function ModerationQueue() {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);

  const admin = !!user?.is_admin;
  const load = useCallback(async () => {
    if (!admin) return;
    try { setError(null); setList(await apiFetch(`/api/reports?status=${status}`)); } catch (e) { setError(e.message); }
  }, [status, admin]);
  useEffect(() => { setList(null); load(); }, [load]);

  async function resolve(r, outcome, remove = false) {
    try {
      if (remove) {
        if (!window.confirm(`Remove this ${r.target_type} for everyone?`)) return;
        await apiFetch(REMOVABLE[r.target_type](r.target_id), { method: 'DELETE' }).catch((e) => { if (e.status !== 404) throw e; });
      }
      await apiFetch(`/api/reports/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: outcome }) });
      toast(remove ? 'Removed and closed' : outcome === 'dismissed' ? 'Report dismissed' : 'Marked as actioned');
      setList((l) => l.filter((x) => x.id !== r.id));
    } catch (e) { toast(e.message); }
  }

  if (!user?.is_admin) return <div className="empty-state">This page is for moderators.</div>;
  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Moderators</span>
          <h1>Reports</h1>
        </div>
        <div className="segmented" role="group" aria-label="Which reports">
          {[['open', 'Open'], ['actioned', 'Actioned'], ['dismissed', 'Dismissed']].map(([v, l]) => <button key={v} aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>)}
        </div>
      </div>
      {error ? <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>
        : list === null ? <p className="muted">Loading…</p>
          : list.length === 0 ? <div className="empty-state">{status === 'open' ? 'Nothing to review. 🎉' : 'None.'}</div>
            : (
              <div className="stack">
                {list.map((r) => (
                  <div key={r.id} className="card stack report-row" style={{ gap: 4 }}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong>{r.reason}</strong>
                      <span className="tag">{r.target_type}</span>
                    </div>
                    {r.target_label && <span style={{ overflowWrap: 'anywhere' }}>“{r.target_label}”</span>}
                    {r.details && <span className="muted" style={{ overflowWrap: 'anywhere' }}>{r.details}</span>}
                    <span className="muted" style={{ fontSize: 13 }}>Reported by {r.reporter_handle} · {new Date(r.created_at).toLocaleString()}</span>
                    {r.status === 'open' && (
                      <div className="row">
                        {REMOVABLE[r.target_type] && <button className="danger-btn" onClick={() => resolve(r, 'actioned', true)}>Remove {r.target_type}</button>}
                        <button onClick={() => resolve(r, 'actioned')}>Mark actioned</button>
                        <button onClick={() => resolve(r, 'dismissed')}>Dismiss</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
    </section>
  );
}
