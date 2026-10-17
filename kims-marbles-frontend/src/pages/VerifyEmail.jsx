// /verify/<token> — the link from the "confirm your email" message. Works logged in or out.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';

export default function VerifyEmail() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState('checking'); // checking | done | failed
  const [err, setErr] = useState(null);
  const once = useRef(null);
  useEffect(() => {
    if (once.current === token) return; // StrictMode runs effects twice; a link works once
    once.current = token;
    apiFetch('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setState('done'))
      .catch((e) => { setErr(e.message); setState('failed'); });
  }, [token]);
  return (
    <div className="login-form">
      {state === 'checking' && <p className="muted">Confirming your email…</p>}
      {state === 'done' && <><h1>Email confirmed ✓</h1><p role="status">Thanks. You can now reset your password by email if you ever need to.</p></>}
      {state === 'failed' && <><h1>Link didn't work</h1><p className="error" role="alert">{err}</p><p className="muted">You can send a new link from your Me page.</p></>}
      {state !== 'checking' && <button className="primary-btn" onClick={() => navigate('/me', { replace: true })}>Continue</button>}
    </div>
  );
}
