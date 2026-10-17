// Who is logged in, shared everywhere. Login/register/logout go through api.js, which owns
// the tokens. When the server rejects the session (or "log out everywhere" runs on another
// device) every screen falls back to the login form.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, setSession, clearSession, loadSession, getRefreshToken, onSessionChange, onSessionEnded } from '../lib/api';
import { startUserSocket, stopUserSocket, emitSetting, onRemoteSetting } from '../lib/userSocket';
import { setSyncSender, applyRemoteChoice } from '../lib/theme';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => loadSession());
  const [notice, setNotice] = useState(null);

  useEffect(() => onSessionChange(setUser), []);
  useEffect(() => onSessionEnded((why) => setNotice(why === 'suspended'
    ? 'This account has been suspended. If you think this is a mistake, contact support.'
    : 'Your session ended. Please log in again.')), []);

  // one live connection per signed-in device: cross-device settings and the device list
  useEffect(() => {
    if (!user) { stopUserSocket(); return undefined; }
    startUserSocket();
    setSyncSender(emitSetting);
    const off = onRemoteSetting('theme', applyRemoteChoice);
    return () => { off(); setSyncSender(null); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (email, password) => {
    const data = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setNotice(null);
    setSession(data);
  }, []);
  const register = useCallback(async (handle, email, password) => {
    const data = await apiFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ handle, email, password }) });
    setNotice(null);
    setSession(data);
  }, []);
  // Revokes the login on the server, then forgets it here (even if the server is unreachable).
  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    try { await apiFetch('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }); } catch (_e) { /* still log out locally */ }
    clearSession();
  }, []);
  // Ends every login of this account. Signs out here only after the server confirms.
  const logoutEverywhere = useCallback(async () => {
    await apiFetch('/api/auth/logout-all', { method: 'POST' });
    clearSession();
  }, []);

  const value = useMemo(() => ({ user, isAuthed: !!user, notice, login, register, logout, logoutEverywhere }), [user, notice, login, register, logout, logoutEverywhere]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
