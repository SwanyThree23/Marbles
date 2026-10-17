// An accessible dialog: focus moves in, Tab stays inside, Escape closes, focus returns to
// whatever opened it.
import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children }) {
  const box = useRef(null);
  // the latest onClose, so a parent re-rendering (a new onClose each time) never re-runs the
  // mount logic below and steals focus from the field being typed in
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onClose = () => closeRef.current();
    const opener = document.activeElement;
    const focusables = () => [...box.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled);
    (focusables()[1] || focusables()[0])?.focus();
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) return;
      const [first, last] = [els[0], els[els.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    const node = box.current;
    node.addEventListener('keydown', onKey);
    return () => { node.removeEventListener('keydown', onKey); if (opener && opener.focus) opener.focus(); };
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 16 }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} className="card" style={{ width: 380, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 26 }}>{title}</h2>
          <button aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
