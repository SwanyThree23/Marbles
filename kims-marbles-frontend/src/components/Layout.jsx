// The shell: brand, notification bell, Go Live, Log Out, and the section nav.
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NotificationBell from './NotificationBell';

const NAV = [
  ['/market', 'Marketplace'], ['/panels', 'Panels'], ['/battles', 'PK-Battles'], ['/feed', 'Feed'],
  ['/collection', 'Collection'], ['/learn', 'Learn'], ['/dashboard', '📊 Dashboard'], ['/messages', 'Messages'], ['/me', 'Me'],
];

export default function Layout() {
  const { logout, user } = useAuth();
  const nav = user?.is_admin ? [...NAV, ['/moderation', '🛡️ Reports']] : NAV;
  const navigate = useNavigate();
  return (
    <>
      <header className="top-header">
        <NavLink to="/market" className="brand" aria-label="Kim's Marbles home">
          <span className="mark" aria-hidden="true" />
          <span><span className="name">Kim's Marbles</span><br /><span className="tagline">where you can find your marbles</span></span>
        </NavLink>
        <div className="header-actions">
          <NotificationBell />
          <button className="primary-btn go-live-btn" onClick={() => navigate('/panels?golive=1')}>● Go Live</button>
          <button className="logout-btn" onClick={logout}>Log Out</button>
        </div>
        <nav aria-label="Sections">
          {nav.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
        </nav>
      </header>
      <main className="page"><Outlet /></main>
    </>
  );
}
