// Direct messages: inbox + one thread. A new conversation starts from a handle.
// New messages arrive as notifications over the user socket, which refresh the open view.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { onNotification } from '../lib/userSocket';
import { useAuth } from '../context/AuthContext';

export default function Messages() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const withId = params.get('with');
  const [inbox, setInbox] = useState(null);
  const [error, setError] = useState(null);
  const [handle, setHandle] = useState('');
  const [findErr, setFindErr] = useState(null);

  const loadInbox = useCallback(async () => {
    try { setError(null); setInbox(await apiFetch('/api/conversations')); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { loadInbox(); }, [loadInbox]);
  useEffect(() => onNotification((n) => { if (n?.type === 'message') loadInbox(); }), [loadInbox]);

  async function start(e) {
    e.preventDefault();
    setFindErr(null);
    const h = handle.trim().replace(/^@/, '');
    if (!h) return;
    try {
      const u = await apiFetch(`/api/users/${encodeURIComponent(h)}`);
      if (u.id === user?.id) return setFindErr('That is you');
      setHandle('');
      setParams({ with: u.id });
    } catch (err) { setFindErr(err.status === 404 ? `No collector called "${h}"` : err.message); }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Direct Messages</span>
          <h1>Messages</h1>
        </div>
      </div>
      <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
        <div className="card stack" style={{ width: 280, maxWidth: '100%' }}>
          <form className="row" onSubmit={start}>
            <input aria-label="Message a collector by handle" placeholder="Message @handle…" value={handle} onChange={(e) => setHandle(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
            <button type="submit">Go</button>
          </form>
          {findErr && <p className="error" role="alert" style={{ margin: 0 }}>{findErr}</p>}
          {error ? <><p className="error">{error}</p><button onClick={loadInbox}>Retry</button></>
            : inbox === null ? <span className="muted">Loading…</span>
              : inbox.length === 0 ? <span className="muted">No conversations yet.</span>
                : inbox.map((c) => (
                  <button key={c.id} className="card" aria-current={withId === c.other_id} onClick={() => setParams({ with: c.other_id })}
                    style={{ textAlign: 'left', padding: 10, borderColor: withId === c.other_id ? 'var(--accent)' : undefined }}>
                    <strong>{c.other_icon || '🔮'} {c.other_handle}</strong>{c.unread && <span aria-label="unread"> ●</span>}
                    <div className="muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.last_text || ' '}</div>
                  </button>
                ))}
        </div>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          {withId ? <Thread key={withId} otherId={withId} me={user?.id} onSent={loadInbox} /> : <div className="empty-state">Pick a conversation, or message someone by their handle.</div>}
        </div>
      </div>
    </section>
  );
}

function Thread({ otherId, me, onSent }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const end = useRef(null);
  const load = useCallback(async () => {
    try { setError(null); setT(await apiFetch(`/api/conversations/with/${otherId}`)); } catch (e) { setError(e.message); }
  }, [otherId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onNotification((n) => { if (n?.type === 'message') load(); }), [load]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [t]);

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    try {
      const m = await apiFetch(`/api/conversations/with/${otherId}`, { method: 'POST', body: JSON.stringify({ text: body }) });
      setT((x) => ({ ...x, messages: [...x.messages, m] }));
      setText('');
      onSent();
    } catch (err) { setError(err.message); }
  }
  if (!t) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <div className="card stack" style={{ minHeight: 360 }}>
      <strong>{t.other.handle}</strong>
      <div className="stack" style={{ gap: 6, flex: 1, maxHeight: '55vh', overflowY: 'auto' }}>
        {t.messages.length === 0 && <span className="muted">Say hello to {t.other.handle}.</span>}
        {t.messages.map((m) => (
          <div key={m.id} className="dm-msg" style={{ alignSelf: m.sender_id === me ? 'flex-end' : 'flex-start', maxWidth: '80%', background: m.sender_id === me ? 'var(--panel2)' : 'transparent', border: '1px solid var(--line)', borderRadius: 10, padding: '6px 10px', overflowWrap: 'anywhere' }}>
            {m.text}
          </div>
        ))}
        <div ref={end} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="row" onSubmit={send}>
        <input aria-label="Message" placeholder={`Message ${t.other.handle}…`} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" className="primary-btn">Send</button>
      </form>
    </div>
  );
}
