// Routes, behind a login gate. Pages other than the marketplace load on demand.
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './components/Toast';
import Layout from './components/Layout';
import Marketplace from './pages/Marketplace';

const Panels = lazy(() => import('./pages/Panels'));
const Battles = lazy(() => import('./pages/Battles'));
const Feed = lazy(() => import('./pages/Feed'));
const Collection = lazy(() => import('./pages/Collection'));
const Learn = lazy(() => import('./pages/Learn'));
const Me = lazy(() => import('./pages/Me'));
const Messages = lazy(() => import('./pages/Messages'));
const JoinInvite = lazy(() => import('./pages/JoinInvite'));
const LiveByRoom = lazy(() => import('./pages/LiveByRoom'));
const Dashboard = lazy(() => import('./pages/Dashboard'));

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}

export function Gate() {
  const { isAuthed } = useAuth();
  if (!isAuthed) return <AuthScreen />;
  return (
    <Suspense fallback={<p className="muted" style={{ padding: 24 }}>Loading…</p>}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/market" replace />} />
          <Route path="/market" element={<Marketplace />} />
          <Route path="/panels" element={<Panels />} />
          <Route path="/battles" element={<Battles />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/collection" element={<Collection />} />
          <Route path="/learn" element={<Learn />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/join/:token" element={<JoinInvite />} />
          <Route path="/live/:roomId" element={<LiveByRoom />} />
          <Route path="/me" element={<Me />} />
          <Route path="*" element={<Navigate to="/market" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function AuthScreen() {
  const { login, register, notice } = useAuth();
  const [mode, setMode] = useState('login');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(handle.trim(), email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <h1>Kim's Marbles</h1>
      <p className="muted">where you can find your marbles</p>
      {notice && <p role="status">{notice}</p>}
      {mode === 'register' && <input placeholder="Handle" aria-label="Handle" autoComplete="username" value={handle} onChange={(e) => setHandle(e.target.value)} />}
      <input placeholder="Email" aria-label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" aria-label="Password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary-btn" disabled={busy}>{mode === 'login' ? 'Log In' : 'Create Account'}</button>
      <button type="button" className="link-btn" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
      </button>
    </form>
  );
}
