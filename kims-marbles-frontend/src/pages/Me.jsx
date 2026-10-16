// Your account: profile, appearance (synced across your devices), your devices, live-chat
// moderation, and payouts.
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import { getThemeChoice, setThemeChoice, subscribeTheme } from '../lib/theme';
import { onDevices, getDeviceId } from '../lib/userSocket';
import { useAuth } from '../context/AuthContext';

export default function Me() {
  const { user } = useAuth();
  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Your Account</span>
          <h1>Me</h1>
          <p className="muted">Signed in as <strong>{user?.handle}</strong>.</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        <Appearance />
        <Devices />
        <Moderation />
        <Payouts />
      </div>
    </section>
  );
}

function Appearance() {
  const [choice, setChoice] = useState(getThemeChoice());
  useEffect(() => subscribeTheme(({ choice: c }) => setChoice(c)), []);
  return (
    <div className="settings-card">
      <h2 style={{ fontSize: 22 }}>Appearance</h2>
      <p className="muted">Applies to all your signed-in devices.</p>
      <div className="segmented" role="group" aria-label="Theme">
        {[['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '🖥️ System']].map(([v, label]) => (
          <button key={v} aria-pressed={choice === v} onClick={() => setThemeChoice(v)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

function Devices() {
  const { logoutEverywhere } = useAuth();
  const [list, setList] = useState([]);
  const [err, setErr] = useState(null);
  useEffect(() => onDevices(setList), []);
  const me = getDeviceId();
  async function signOutAll() {
    if (!window.confirm('Sign out of Kim\'s Marbles on every device, including this one?')) return;
    try { setErr(null); await logoutEverywhere(); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="settings-card">
      <h2 style={{ fontSize: 22 }}>Your devices</h2>
      <p className="muted">{list.length <= 1 ? 'Only this device is signed in right now.' : `${list.length} devices are signed in right now.`}</p>
      <ul style={{ paddingLeft: 18 }}>
        {list.map((d) => <li key={d.deviceId}>{d.label}{d.deviceId === me ? ' (this device)' : ''}</li>)}
      </ul>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="danger-btn" onClick={signOutAll}>Sign out of all devices</button>
    </div>
  );
}

function Moderation() {
  const [enabled, setEnabled] = useState(false);
  const [words, setWords] = useState('');
  const [state, setState] = useState('loading'); // loading | idle | saving | saved | error
  const [err, setErr] = useState(null);
  useEffect(() => {
    apiFetch('/api/moderation').then((m) => { setEnabled(m.enabled); setWords(m.words.join('\n')); setState('idle'); })
      .catch((e) => { setErr(e.message); setState('error'); });
  }, []);
  async function save() {
    setState('saving'); setErr(null);
    try {
      const list = words.split('\n').map((w) => w.trim()).filter(Boolean);
      const m = await apiFetch('/api/moderation', { method: 'PUT', body: JSON.stringify({ enabled, words: list }) });
      setWords(m.words.join('\n'));
      setState('saved');
    } catch (e) { setErr(e.message); setState('error'); }
  }
  return (
    <div className="settings-card">
      <h2 style={{ fontSize: 22 }}>Live Chat Moderation</h2>
      <p className="muted">Messages in your streams that contain these words are blocked before anyone sees them.</p>
      <label className="row" style={{ marginBottom: 8 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setState('idle'); }} />
        Block messages containing these words in my live chats
      </label>
      <textarea rows={4} placeholder="One word or phrase per line" aria-label="Blocked words, one per line" value={words} onChange={(e) => { setWords(e.target.value); setState('idle'); }} />
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={save} disabled={state === 'saving' || state === 'loading'}>Save</button>
        {state === 'saved' && <span role="status">✓ Saved</span>}
      </div>
    </div>
  );
}

function Payouts() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { apiFetch('/api/payments/status').then(setStatus).catch((e) => setErr(e.message)); }, []);
  async function onboard() {
    try { const r = await apiFetch('/api/payments/onboard', { method: 'POST' }); if (r.url) window.location.assign(r.url); } catch (e) { setErr(e.message); }
  }
  const text = !status ? 'Checking your payout status…'
    : !status.onboarded ? "Not set up yet. Viewers can't tip you and buyers can't pay you until you do."
      : status.chargesEnabled ? '✅ Payouts are active: you can receive tips and sales.' : 'Setup started. Finish it on Stripe to start receiving money.';
  return (
    <div className="settings-card">
      <h2 style={{ fontSize: 22 }}>Payouts &amp; Tipping</h2>
      <p className="muted">{err || text}</p>
      <button onClick={onboard}>💳 Set Up Payouts</button>
    </div>
  );
}
