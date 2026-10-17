// /reset/<token> — the link from the "reset your password" email. Works logged in or out.
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiFetch, clearSession } from '../lib/api';

export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState(null);
  const [state, setState] = useState('idle'); // idle | saving | done

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) return setErr('Use at least 8 characters');
    if (password !== again) return setErr("The two passwords don't match");
    setState('saving');
    try {
      await apiFetch('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
      clearSession(); // every login was ended by the reset, this one too
      setState('done');
    } catch (e2) { setErr(e2.message); setState('idle'); }
  }

  if (state === 'done') {
    return (
      <div className="login-form">
        <h1>Password changed</h1>
        <p role="status">Your new password is set, and you've been logged out everywhere else.</p>
        <button className="primary-btn" onClick={() => navigate('/', { replace: true })}>Log In</button>
      </div>
    );
  }
  return (
    <form className="login-form" onSubmit={submit}>
      <h1>New password</h1>
      <input type="password" placeholder="New password" aria-label="New password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <input type="password" placeholder="New password again" aria-label="New password again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {err && <p className="error" role="alert">{err}</p>}
      <button type="submit" className="primary-btn" disabled={state === 'saving'}>Save new password</button>
      <button type="button" className="link-btn" onClick={() => navigate('/', { replace: true })}>Back to log in</button>
    </form>
  );
}
