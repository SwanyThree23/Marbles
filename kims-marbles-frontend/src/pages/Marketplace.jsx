// Buy · Sell · Trade. Listings, filters, search, the listing form (with saved templates),
// and the deal room (buy / offer / trade / bid).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { CATEGORIES, money, parsePriceToCents } from '../lib/learnData';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';

const TYPES = [['sale', 'For Sale'], ['trade', 'Trade Only'], ['auction', 'Auction']];
const GRADES = [['mint', 'Mint'], ['near-mint', 'Near Mint'], ['good', 'Good']];
const blankForm = { name: '', category: 'Swirl', grade: 'mint', type: 'sale', price: '50', description: '' };

export default function Marketplace() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [listings, setListings] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [leaders, setLeaders] = useState([]);
  const [form, setForm] = useState(null);       // the listing form, or null when closed
  const [deal, setDeal] = useState(null);
  const [inbox, setInbox] = useState(false);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (filter === 'auction') p.set('type', 'auction'); else if (filter !== 'all') p.set('category', filter);
    if (q.trim()) p.set('q', q.trim());
    try {
      setError(null);
      setListings(await apiFetch(`/api/listings${p.toString() ? `?${p}` : ''}`));
    } catch (err) {
      setError(err.message);
    }
  }, [filter, q]);

  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { apiFetch('/api/battles/leaderboard').then(setLeaders).catch(() => {}); }, []);

  // /market?template=<id> (from the dashboard): open the form pre-filled, then drop the param
  const templateId = params.get('template');
  const handled = useRef(null);
  useEffect(() => {
    if (!templateId || handled.current === templateId) return;
    handled.current = templateId;
    apiFetch('/api/templates').then((list) => {
      const t = list.find((x) => x.id === templateId);
      if (t) setForm({ name: t.name, category: t.category, grade: t.grade, type: t.type, price: (t.price_cents / 100).toFixed(2), description: t.description });
      else toast('That template no longer exists');
    }).catch((err) => toast(err.message)).finally(() => navigate('/market', { replace: true }));
  }, [templateId, navigate, toast]);

  // back from Stripe Checkout: /market?paid=<offerId> or ?cancelled=<offerId>
  const paid = params.get('paid');
  const cancelled = params.get('cancelled');
  useEffect(() => {
    if (!paid && !cancelled) return;
    toast(paid ? 'Payment received — thank you! The seller has been notified.' : 'Checkout cancelled. You have not been charged.');
    navigate('/market', { replace: true });
  }, [paid, cancelled, navigate, toast]);

  return (
    <section>
      <div className="page-head">
        <div>
          <span className="tag">Community Marketplace</span>
          <h1>Buy · Sell · Trade</h1>
          <p className="muted">Live listings from the community. Tap a card to open the deal room.</p>
        </div>
        <div className="row">
          <button onClick={() => setInbox(true)}>📬 Offers</button>
          <button className="primary-btn" onClick={() => setForm({ ...blankForm })}>＋ List a Marble</button>
        </div>
      </div>
      <input type="search" aria-label="Search listings by name" placeholder="Search listings by name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
      <div className="row" role="group" aria-label="Filter listings" style={{ marginBottom: 14 }}>
        {[['all', 'All'], ...CATEGORIES.map((c) => [c, c]), ['auction', '🔨 Live Auctions']].map(([v, label]) => (
          <button key={v} aria-pressed={filter === v} className={filter === v ? 'accent-btn' : ''} onClick={() => setFilter(v)}>{label}</button>
        ))}
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {error ? (
            <div className="empty-state"><p className="error">{error}</p><button onClick={load}>Retry</button></div>
          ) : listings === null ? <p className="muted">Loading listings…</p>
            : listings.length === 0 ? <div className="empty-state">No listings here yet. Be the first: tap “＋ List a Marble”.</div>
            : (
              <div className="grid">
                {listings.map((l) => <ListingCard key={l.id} l={l} onOpen={() => setDeal(l)} />)}
              </div>
            )}
        </div>
        <aside className="card" style={{ width: 230, maxWidth: '100%' }}>
          <h3 style={{ fontSize: 20, color: 'var(--accent-text)' }}>🏆 Top Collectors</h3>
          {leaders.length ? leaders.map((r, i) => <div key={r.handle} className="row" style={{ justifyContent: 'space-between' }}><span>#{i + 1} {r.handle}</span><span className="mono">{r.points.toLocaleString()} pts</span></div>)
            : <p className="muted">No battles yet. Be the first to challenge someone!</p>}
        </aside>
      </div>
      {form && <ListingForm initial={form} onClose={() => setForm(null)} onPublished={() => { setForm(null); setFilter('all'); load(); }} />}
      {inbox && <OffersInbox onClose={() => setInbox(false)} onChanged={load} />}
      {deal && <DealRoom listing={deal} onClose={() => setDeal(null)} onChanged={load} />}
    </section>
  );
}

function ListingCard({ l, onOpen }) {
  const price = l.type === 'trade' ? 'Trade only' : l.type === 'auction' ? `${money(l.current_bid_cents)} bid` : money(l.price_cents);
  return (
    <button className="card" onClick={onOpen} style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4, padding: 14 }}>
      <span className="tag">{l.type === 'trade' ? 'Trade' : l.type === 'auction' ? 'Auction' : 'For Sale'} · {l.grade.replace('-', ' ')}</span>
      <strong style={{ fontSize: 17 }}>{l.name}</strong>
      <span className="muted">{l.category}</span>
      {l.description && <span className="muted" style={{ fontSize: 14 }}>{l.description}</span>}
      <span className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
        <span className="mono" style={{ color: 'var(--accent-text)' }}>{price}</span>
        <span>{l.seller_handle}</span>
      </span>
    </button>
  );
}

function ListingForm({ initial, onClose, onPublished }) {
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  function payload() {
    if (!f.name.trim()) { setErr('Give your marble a name'); return null; }
    const cents = f.type === 'trade' ? 0 : parsePriceToCents(f.price);
    if (cents === null) { setErr('Enter a price like 42 or 42.50'); return null; }
    return { name: f.name.trim(), category: f.category, grade: f.grade, type: f.type, priceCents: cents, description: f.description.trim() };
  }
  async function publish() {
    const body = payload();
    if (!body) return;
    setBusy(true); setErr(null);
    try {
      await apiFetch('/api/listings', { method: 'POST', body: JSON.stringify(body) });
      toast(`"${body.name}" is live on the marketplace`);
      onPublished();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function saveTemplate() {
    const body = payload();
    if (!body) return;
    try {
      await apiFetch('/api/templates', { method: 'POST', body: JSON.stringify(body) });
      toast(`Template "${body.name}" saved`);
    } catch (e) { setErr(e.message); }
  }
  return (
    <Modal title="List a Marble" onClose={onClose}>
      <div className="stack">
        <input placeholder="Name" aria-label="Name" value={f.name} onChange={set('name')} maxLength={120} />
        <label className="stack" style={{ gap: 4 }}>Category
          <select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="stack" style={{ gap: 4 }}>Condition
          <select value={f.grade} onChange={set('grade')}>{GRADES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <div className="segmented" role="group" aria-label="Listing type">
          {TYPES.map(([v, l]) => <button key={v} type="button" aria-pressed={f.type === v} onClick={() => setF({ ...f, type: v })}>{l}</button>)}
        </div>
        {f.type !== 'trade' && <input placeholder="Price ($)" aria-label={f.type === 'auction' ? 'Starting bid ($)' : 'Price ($)'} inputMode="decimal" value={f.price} onChange={set('price')} />}
        <textarea placeholder="Description" aria-label="Description" value={f.description} onChange={set('description')} maxLength={2000} rows={3} />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary-btn" onClick={publish} disabled={busy}>Publish Listing</button>
        <button onClick={saveTemplate}>💾 Save as Template</button>
      </div>
    </Modal>
  );
}

function DealRoom({ listing: l, onClose, onChanged }) {
  const toast = useToast();
  const [amount, setAmount] = useState(l.type === 'auction' ? ((l.current_bid_cents + (l.current_bidder_id ? 500 : 0)) / 100).toFixed(2) : (l.price_cents / 100).toFixed(2));
  const [mine, setMine] = useState([]);
  const [picked, setPicked] = useState([]);
  const [err, setErr] = useState(null);
  useEffect(() => { apiFetch('/api/collection').then(setMine).catch(() => {}); }, []);

  async function send(kind) {
    setErr(null);
    try {
      if (l.type === 'auction' && kind === 'bid') {
        const cents = parsePriceToCents(amount);
        if (cents === null) return setErr('Enter a bid like 25 or 25.50');
        const r = await apiFetch(`/api/listings/${l.id}/bids`, { method: 'POST', body: JSON.stringify({ amountCents: cents }) });
        toast(`You bid ${money(r.currentBidCents)}: you're the highest bidder`);
      } else {
        const body = { kind };
        if (kind === 'offer') { const c = parsePriceToCents(amount); if (c === null) return setErr('Enter an offer like 70'); body.offerAmountCents = c; }
        if (kind === 'trade') { if (!picked.length) return setErr('Pick at least one marble to offer'); body.tradeItemIds = picked; }
        await apiFetch(`/api/listings/${l.id}/offers`, { method: 'POST', body: JSON.stringify(body) });
        toast(`Sent to ${l.seller_handle}`);
      }
      onChanged();
      onClose();
    } catch (e) { setErr(e.message); }
  }
  return (
    <Modal title="Deal Room" onClose={onClose}>
      <div className="stack">
        <strong>{l.name}</strong>
        <span className="muted">{l.type === 'trade' ? 'Trade only' : money(l.type === 'auction' ? l.current_bid_cents : l.price_cents)} · {l.seller_handle}</span>
        {l.type === 'auction' ? (
          <>
            <label className="stack" style={{ gap: 4 }}>Your bid ($)<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button className="primary-btn" onClick={() => send('bid')}>Place Bid</button>
          </>
        ) : (
          <>
            {l.type === 'sale' && <button className="primary-btn" onClick={() => send('buy')}>Buy Now — {money(l.price_cents)}</button>}
            {l.type === 'sale' && (
              <div className="row"><input aria-label="Your offer ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ flex: 1 }} /><button onClick={() => send('offer')}>Send Offer</button></div>
            )}
            <fieldset className="stack" style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend className="muted">Offer from your collection</legend>
              {mine.length ? mine.map((m) => (
                <label key={m.id} className="row"><input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />{m.icon} {m.name}</label>
              )) : <span className="muted">Your collection is empty. Add marbles to propose a trade.</span>}
              {mine.length > 0 && <button onClick={() => send('trade')}>Send Trade Proposal</button>}
            </fieldset>
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

// Offers on my listings (answer them) and offers I made (pay once accepted).
function OffersInbox({ onClose, onChanged }) {
  const toast = useToast();
  const [role, setRole] = useState('seller');
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    try { setErr(null); setList(await apiFetch(`/api/offers?role=${role}`)); } catch (e) { setErr(e.message); }
  }, [role]);
  useEffect(() => { setList(null); load(); }, [load]);

  async function answer(o, status) {
    try { await apiFetch(`/api/offers/${o.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); toast(`Offer ${status}`); load(); onChanged(); } catch (e) { setErr(e.message); }
  }
  async function pay(o) {
    try {
      const r = await apiFetch('/api/payments/checkout', { method: 'POST', body: JSON.stringify({ offerId: o.id }) });
      if (r.url) window.location.assign(r.url);
    } catch (e) { setErr(e.message); }
  }
  const what = (o) => (o.kind === 'trade' ? `trade (${o.trade_item_ids.length} marble${o.trade_item_ids.length === 1 ? '' : 's'})` : o.kind === 'buy' ? `buy at ${money(o.offer_amount_cents)}` : `offer of ${money(o.offer_amount_cents)}`);
  return (
    <Modal title="Offers" onClose={onClose}>
      <div className="segmented" role="group" aria-label="Which offers" style={{ marginBottom: 10 }}>
        <button aria-pressed={role === 'seller'} onClick={() => setRole('seller')}>On my listings</button>
        <button aria-pressed={role === 'buyer'} onClick={() => setRole('buyer')}>I made</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 ? <p className="muted">No offers yet.</p> : (
        <div className="stack">
          {list.map((o) => (
            <div key={o.id} className="card stack offer-row" style={{ gap: 4, padding: 10 }}>
              <strong>{o.listing_name}</strong>
              <span className="muted">{role === 'seller' ? o.buyer_handle : 'You'}: {what(o)} · <b>{o.status}</b></span>
              {role === 'seller' && o.status === 'pending' && (
                <div className="row"><button className="primary-btn" onClick={() => answer(o, 'accepted')}>Accept</button><button onClick={() => answer(o, 'declined')}>Decline</button></div>
              )}
              {role === 'buyer' && o.status === 'accepted' && o.offer_amount_cents > 0 && (
                <button className="primary-btn" onClick={() => pay(o)}>💳 Pay {money(o.offer_amount_cents)}</button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
