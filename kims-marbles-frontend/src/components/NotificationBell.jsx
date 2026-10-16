// 🔔 with an unread count. Loads on open and updates live from the per-device socket.
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { onNotification } from '../lib/userSocket';

export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const load = () => apiFetch('/api/notifications').then(setItems).catch(() => {});
  useEffect(() => { load(); return onNotification((n) => setItems((list) => [n, ...list])); }, []);
  const unread = items.filter((n) => !n.read).length;
  async function markRead(n) {
    if (n.read) return;
    setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    apiFetch(`/api/notifications/${n.id}/read`, { method: 'PATCH' }).catch(() => {});
  }
  return (
    <div style={{ position: 'relative' }}>
      <button className="bell-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) load(); }}>
        🔔{unread > 0 && <span className="mono" aria-hidden="true"> {unread}</span>}
      </button>
      {open && (
        <div className="card" role="dialog" aria-label="Notifications" style={{ position: 'absolute', right: 0, top: 48, width: 'min(320px, 85vw)', zIndex: 40, maxHeight: '60vh', overflowY: 'auto' }}>
          {items.length === 0 ? <p className="muted">You're all caught up.</p> : items.map((n) => (
            <button key={n.id} onClick={() => markRead(n)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, fontWeight: n.read ? 400 : 700 }}>
              {n.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
