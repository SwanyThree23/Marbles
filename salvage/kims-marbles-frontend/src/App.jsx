import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { VaultProvider } from './context/VaultContext';
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
import './App.css';

export default function App() {
  return (
    <AuthProvider>
      <VaultProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </VaultProvider>
    </AuthProvider>
  );
}

function Gate() {
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
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(handle, email, password);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login-form">
      <h1>Kim's Marbles</h1>
      <p className="muted">where you can find your marbles</p>
      {mode === 'register' && <input placeholder="Handle" value={handle} onChange={(e) => setHandle(e.target.value)} />}
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button className="primary-btn" onClick={submit}>{mode === 'login' ? 'Log In' : 'Create Account'}</button>
      <button className="link-btn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Log in'}
      </button>
    </div>
  );
}
