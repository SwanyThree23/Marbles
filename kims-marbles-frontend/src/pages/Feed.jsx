// Community feed: post (optionally with a marble from your collection), like, comment.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function Feed() {
  const { user } = useAuth();
  const toast = useToast();
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [attach, setAttach] = useState('');
  const [mine, setMine] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setError(null); setPosts(await apiFetch('/api/feed')); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); apiFetch('/api/collection').then(setMine).catch(() => {}); }, [load]);

  async function post() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await apiFetch('/api/feed', { method: 'POST', body: JSON.stringify({ text: text.trim(), ...(attach ? { attachCollectionItemId: attach } : {}) }) });
      setText(''); setAttach('');
      await load();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  }
  async function like(p) {
    try {
      const r = await apiFetch(`/api/feed/${p.id}/like`, { method: 'POST' });
      setPosts((list) => list.map((x) => (x.id === p.id ? { ...x, liked_by_me: r.liked, like_count: r.likeCount } : x)));
    } catch (e) { toast(e.message); }
  }
  async function remove(p) {
    if (!window.confirm('Delete this post?')) return;
    try { await apiFetch(`/api/feed/${p.id}`, { method: 'DELETE' }); setPosts((l) => l.filter((x) => x.id !== p.id)); } catch (e) { toast(e.message); }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Community</span>
          <h1>Feed</h1>
          <p className="muted">Share a find, show off a haul, enter this week's #SwirlChallenge.</p>
        </div>
      </div>
      <div className="card stack" style={{ marginBottom: 16 }}>
        <textarea rows={3} maxLength={2000} placeholder="Share a haul, a find, or a question…" aria-label="New post" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <select aria-label="Attach a marble" value={attach} onChange={(e) => setAttach(e.target.value)} style={{ maxWidth: 240 }}>
            <option value="">No marble attached</option>
            {mine.map((m) => <option key={m.id} value={m.id}>{m.icon} {m.name}</option>)}
          </select>
          <button className="primary-btn" onClick={post} disabled={busy || !text.trim()}>Post</button>
        </div>
      </div>
      {error ? <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>
        : posts === null ? <p className="muted">Loading the feed…</p>
          : posts.length === 0 ? <div className="empty-state">Nothing here yet. Be the first to post.</div>
            : <div className="stack">{posts.map((p) => <Post key={p.id} p={p} mine={p.author_id === user?.id} onLike={() => like(p)} onDelete={() => remove(p)} />)}</div>}
    </section>
  );
}

function Post({ p, mine, onLike, onDelete }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState(null);
  const [reply, setReply] = useState('');
  const [count, setCount] = useState(p.comment_count);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && comments === null) {
      try { setComments(await apiFetch(`/api/feed/${p.id}/comments`)); } catch (e) { toast(e.message); setComments([]); }
    }
  }
  async function send(e) {
    e.preventDefault();
    if (!reply.trim()) return;
    try {
      const c = await apiFetch(`/api/feed/${p.id}/comments`, { method: 'POST', body: JSON.stringify({ text: reply.trim() }) });
      setComments((l) => [...(l || []), c]); setCount((n) => n + 1); setReply('');
    } catch (err) { toast(err.message); }
  }
  return (
    <article className="card stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{p.author_icon || '🔮'} {p.author_handle}</strong>
        <span className="muted" style={{ fontSize: 13 }}>{ago(p.created_at)}</span>
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{p.text}</p>
      {p.attach_name && <span className="tag" style={{ alignSelf: 'flex-start' }}>{p.attach_icon} {p.attach_name}</span>}
      <div className="row">
        <button aria-pressed={!!p.liked_by_me} onClick={onLike}>{p.liked_by_me ? '❤️' : '🤍'} {p.like_count}</button>
        <button aria-expanded={open} onClick={toggle}>💬 {count}</button>
        {mine && <button className="link-btn" onClick={onDelete}>Delete</button>}
      </div>
      {open && (
        <div className="stack" style={{ gap: 6 }}>
          {comments === null ? <span className="muted">Loading…</span> : comments.map((c) => <div key={c.id} style={{ fontSize: 14 }}><b>{c.author_handle}</b> {c.text}</div>)}
          <form className="row" onSubmit={send}>
            <input aria-label="Write a comment" placeholder="Write a comment…" maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: 1 }} />
            <button type="submit">Reply</button>
          </form>
        </div>
      )}
    </article>
  );
}
