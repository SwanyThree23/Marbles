// /live/:roomId — a shareable link to a live room. Also where Stripe sends a viewer back after
// a tip (?tip=success | ?tip=cancelled).
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import LiveRoom from './LiveRoom';

export default function LiveByRoom() {
  const { roomId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [room, setRoom] = useState(null);
  const [error, setError] = useState(null);
  const [tip] = useState(params.get('tip'));

  useEffect(() => {
    if (tip) navigate(`/live/${roomId}`, { replace: true }); // a refresh should not thank them twice
    apiFetch(`/api/rooms/${roomId}`).then(setRoom).catch((e) => setError(e.message));
  }, [roomId]); // eslint-disable-line react-hooks/exhaustive-deps

  const thanks = tip === 'success' ? `Thank you — your tip was sent${room ? ` to ${room.host_handle}` : ''}!`
    : tip === 'cancelled' ? 'Tip cancelled. You have not been charged.' : null;

  if (error) return <div className="empty-state"><p className="error">{error}</p><button onClick={() => navigate('/panels')}>Back to Panels</button></div>;
  if (!room) return <p className="muted">Loading…</p>;
  if (room.status !== 'live') {
    return (
      <div className="empty-state">
        {thanks && <p role="status">{thanks}</p>}
        <p>{room.status === 'ended' ? `"${room.title}" has ended.` : `"${room.title}" has not started yet.`}</p>
        <button onClick={() => navigate('/panels')}>Back to Panels</button>
      </div>
    );
  }
  return (
    <>
      {thanks && <div role="status" className="toast" style={{ zIndex: 70 }}>{thanks}</div>}
      <LiveRoom room={room} onLeave={() => navigate('/panels')} />
    </>
  );
}
