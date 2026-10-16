// /join/:token — redeem a one-time stage invite, then go to the room.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';

export default function JoinInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const tried = useRef(null);
  useEffect(() => {
    if (tried.current === token) return; // StrictMode runs effects twice; redeem once
    tried.current = token;
    apiFetch(`/api/rooms/invite/${encodeURIComponent(token)}`, { method: 'POST' })
      .then((r) => navigate(`/live/${r.room.id}`, { replace: true }))
      .catch((e) => setError(e.message));
  }, [token, navigate]);
  if (error) return <div className="empty-state"><p className="error">{error}</p><button onClick={() => navigate('/panels')}>Back to Panels</button></div>;
  return <p className="muted">Joining the stream…</p>;
}
