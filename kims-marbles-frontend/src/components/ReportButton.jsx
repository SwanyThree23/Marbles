// "⚑ Report" for a listing, post, person or live room. Goes to the admins' moderation queue.
import { useState } from 'react';
import { apiFetch } from '../lib/api';
import Modal from './Modal';

export const REASONS = ['Spam', 'Scam or fraud', 'Harassment or hate', 'Inappropriate content', 'Counterfeit or misdescribed item', 'Something else'];
const NOUN = { listing: 'listing', post: 'post', user: 'person', panel: 'live stream', comment: 'comment' };

export default function ReportButton({ targetType, targetId, targetLabel = '', className = 'link-btn', children }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]);
  const [details, setDetails] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | sent
  const [err, setErr] = useState(null);

  async function send() {
    setState('sending'); setErr(null);
    try {
      await apiFetch('/api/reports', { method: 'POST', body: JSON.stringify({ targetType, targetId, targetLabel: targetLabel.slice(0, 200), reason, details: details.trim() }) });
      setState('sent');
    } catch (e) { setErr(e.message); setState('idle'); }
  }
  const close = () => { setOpen(false); setState('idle'); setDetails(''); setErr(null); };
  return (
    <>
      <button type="button" className={className} title={`Report this ${NOUN[targetType]}`} onClick={() => setOpen(true)}>{children || '⚑ Report'}</button>
      {open && (
        <Modal title={`Report this ${NOUN[targetType]}`} onClose={close}>
          {state === 'sent' ? (
            <div className="stack">
              <p role="status">Thanks. A moderator will review it.</p>
              <button className="primary-btn" onClick={close}>Done</button>
            </div>
          ) : (
            <div className="stack">
              <label className="stack" style={{ gap: 4 }}>What's wrong?
                <select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
              </label>
              <textarea rows={3} maxLength={1000} aria-label="Details (optional)" placeholder="Details (optional)" value={details} onChange={(e) => setDetails(e.target.value)} />
              {err && <p className="error" role="alert">{err}</p>}
              <button className="primary-btn" onClick={send} disabled={state === 'sending'}>Send report</button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
