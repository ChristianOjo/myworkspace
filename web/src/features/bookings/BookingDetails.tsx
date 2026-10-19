import { useCallback, useEffect, useRef, useState } from 'react';
import type { BookingDetail as BookingRecord, Balance, Location, Payment } from '../../api/types';
import { cancelBooking, getBooking, markArrived, refundPayment, releaseBooking, takePayment } from '../../api/routes';
import { Drawer } from '../../components/Drawer';
import { Loading } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { friendlyError } from '../../lib/errors';
import { formatDateTime, isManager, money, parseMoneyToCents } from '../../lib/format';

interface DetailState { booking: BookingRecord; balance: Balance; payments: Payment[]; }

export function BookingDetails({ id, location, role, currency, onClose, onUpdated, notify }: {
  id: string | null;
  location?: Location;
  role: string;
  currency: string;
  onClose: () => void;
  onUpdated: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
}) {
  const [data, setData] = useState<DetailState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [refundOnCancel, setRefundOnCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [note, setNote] = useState('');
  const requestVersion = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError('');
    try {
      const result = await getBooking(id);
      if (requestVersion.current !== version) return;
      setData(result);
      setPaymentAmount((result.balance.dueCents / 100).toFixed(2));
      setRefundAmount((result.balance.netPaidCents / 100).toFixed(2));
    } catch (cause) {
      if (requestVersion.current === version) setError(friendlyError(cause, 'Could not load this booking.'));
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    setLoading(false);
    setBusy(false);
    setError('');
    setConfirmCancel(false);
    setRefundOnCancel(false);
    setCancelReason('');
    setPaymentAmount('');
    setRefundAmount('');
    setNote('');
    inFlight.current = false;
    if (id) void load();
    return () => { requestVersion.current += 1; };
  }, [id, load]);

  async function perform(action: () => Promise<unknown>, successMessage: string, closeAfter = false): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      notify(successMessage);
      onUpdated();
      if (closeAfter) onClose();
      else await load();
      return true;
    } catch (cause) {
      const message = friendlyError(cause);
      setError(message);
      notify(message, 'error');
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const booking = data?.booking;
  const balance = data?.balance;
  const manager = isManager(role);
  const startMs = booking ? new Date(booking.start).getTime() : 0;
  const endMs = booking ? new Date(booking.end).getTime() : 0;
  const canArrive = !!booking && booking.status === 'confirmed' && Date.now() >= startMs - 15 * 60_000 && Date.now() <= endMs;
  const canPay = !!booking && !!balance && ['confirmed', 'checked_in', 'completed'].includes(booking.status) && balance.dueCents > 0;
  const canRefund = !!balance && balance.netPaidCents > 0 && manager;

  async function submitPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !balance) return;
    const cents = parseMoneyToCents(paymentAmount);
    if (cents <= 0) { setError('Enter an amount above 0.'); return; }
    if (cents > balance.dueCents) { setError(`That is more than the ${money(balance.dueCents, currency)} due.`); return; }
    if (await perform(() => takePayment(id, cents, note.trim() || undefined), 'Payment recorded.')) setNote('');
  }

  async function submitRefund(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id || !balance) return;
    const cents = parseMoneyToCents(refundAmount);
    if (cents <= 0 || cents > balance.netPaidCents) { setError(`Enter a refund between ${money(1, currency)} and ${money(balance.netPaidCents, currency)}.`); return; }
    if (await perform(() => refundPayment(id, cents, note.trim() || undefined), 'Refund recorded.')) setNote('');
  }

  async function confirmCancellation() {
    if (!id || !booking || (balance && balance.netPaidCents > 0 && !manager)) return;
    const refundCents = refundOnCancel && balance ? parseMoneyToCents(refundAmount) : undefined;
    if (refundOnCancel && balance && (refundCents === undefined || refundCents <= 0 || refundCents > balance.netPaidCents)) {
      setError(`Enter a refund between ${money(1, currency)} and ${money(balance.netPaidCents, currency)}.`);
      return;
    }
    await perform(() => cancelBooking(id, { ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}), ...(refundCents ? { refundCents } : {}) }), 'Booking cancelled.', true);
  }

  function closeIfIdle() {
    if (!busy) onClose();
  }

  return <Drawer open={!!id} title={booking?.customerName ?? 'Booking details'} onClose={closeIfIdle}>
    {loading && !data ? <Loading label="Loading booking" /> : !data || !booking || !balance ? <div className="drawer-head"><p className="eyebrow">BOOKING / DETAILS</p><h2>Booking unavailable</h2>{error && <div className="form-alert" role="alert">{error}</div>}<button className="button button-quiet" onClick={load}>Try again</button></div> : <>
      <div className="drawer-head">
        <p className="eyebrow">BOOKING / {booking.id.slice(0, 8).toUpperCase()}</p>
        <h2>{booking.customerName}</h2>
        <p className="muted">{booking.resourceName} <span className="dot-separator">·</span> {booking.pricing === 'day' ? 'Whole day' : 'Hourly'}</p>
      </div>
      <div className="detail-state-row"><StatusBadge status={booking.status} /><StatusBadge status={balance.paymentStatus} /></div>
      <div className="detail-facts">
        <div><span>DATE</span><b>{formatDateTime(booking.start, location?.timezone ?? 'UTC', { weekday: 'short', year: 'numeric' })}</b></div>
        <div><span>TIME</span><b>{new Intl.DateTimeFormat('en', { timeZone: location?.timezone ?? 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(booking.start))}–{new Intl.DateTimeFormat('en', { timeZone: location?.timezone ?? 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(booking.end))}</b></div>
        <div><span>CUSTOMER</span><b>{booking.customerName}</b></div>
        <div><span>PHONE</span><b>{booking.customerPhone || '—'}</b></div>
        <div><span>CREATED BY</span><b>{booking.createdByName}</b></div>
        {booking.checkinAt && <div><span>ARRIVED</span><b>{formatDateTime(booking.checkinAt, location?.timezone ?? 'UTC')}</b></div>}
      </div>
      <div className="balance-strip">
        <div><span>PRICE</span><b>{money(balance.priceCents, currency)}</b></div>
        <div><span>PAID</span><b>{money(balance.paidCents, currency)}</b></div>
        <div><span>REFUNDED</span><b>{money(balance.refundedCents, currency)}</b></div>
        <div><span>NET PAID</span><b>{money(balance.netPaidCents, currency)}</b></div>
        <div><span>DUE</span><b>{money(balance.dueCents, currency)}</b></div>
      </div>

      <div className="action-section">
        <p className="section-index">BOOKING ACTIONS</p>
        {booking.status === 'confirmed' && <button className="button button-primary action-wide" onClick={() => void perform(() => markArrived(booking.id), `${booking.customerName} marked as arrived.`)} disabled={busy || !canArrive}>{busy ? 'Saving…' : 'Mark arrived'}<span aria-hidden="true">↗</span></button>}
        {booking.status === 'confirmed' && !canArrive && <p className="small-note">Arrival can be marked from 15 minutes before the start until the booking ends.</p>}
        {booking.status === 'checked_in' && <>
          <button className="button button-primary action-wide" onClick={() => void perform(() => releaseBooking(booking.id), 'Booking released.')} disabled={busy}>{busy ? 'Saving…' : 'Release early'}<span aria-hidden="true">↗</span></button>
          <p className="small-note">Frees the resource from the next 15-minute boundary. Unused time is not refunded.</p>
        </>}
      </div>

      {canPay && <form className="action-section inline-action-form" onSubmit={submitPayment}>
        <p className="section-index">TAKE PAYMENT <span>— CASH</span></p>
        <label className="field-label">Amount
          <div className="money-input"><span>{currency}</span><input inputMode="decimal" value={paymentAmount} onChange={event => setPaymentAmount(event.target.value)} aria-label="Payment amount" /></div>
        </label>
        <label className="field-label">Note <span className="optional-label">OPTIONAL</span><input value={note} onChange={event => setNote(event.target.value)} maxLength={200} placeholder="Payment note" /></label>
        <button className="button button-primary action-wide" type="submit" disabled={busy}>{busy ? 'Recording…' : 'Take payment'}</button>
      </form>}
      {balance.netPaidCents > 0 && !manager && <div className="permission-note">Refunds and cancellation of paid bookings need a location manager.</div>}
      {canRefund && <form className="action-section inline-action-form" onSubmit={submitRefund}>
        <p className="section-index">REFUND <span>— MANAGER</span></p>
        <label className="field-label">Amount
          <div className="money-input"><span>{currency}</span><input inputMode="decimal" value={refundAmount} onChange={event => setRefundAmount(event.target.value)} aria-label="Refund amount" /></div>
        </label>
        <button className="button button-outline action-wide" type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record refund'}</button>
      </form>}

      {booking.status === 'confirmed' && (balance.netPaidCents === 0 || manager) && <div className="action-section cancel-section">
        <p className="section-index">CANCEL BOOKING</p>
        {!confirmCancel ? <button className="button button-danger-quiet action-wide" onClick={() => setConfirmCancel(true)} disabled={busy}>Cancel booking</button> : <div className="cancel-confirmation">
          <p>This will release the slot. The server will re-check the booking state.</p>
          {manager && balance.netPaidCents > 0 && <>
            <label className="check-row"><input type="checkbox" checked={refundOnCancel} onChange={event => setRefundOnCancel(event.target.checked)} />Refund with cancellation</label>
            {!refundOnCancel && <p className="form-alert" role="note">The {money(balance.netPaidCents, currency)} already paid stays recorded as kept cash. Tick “Refund with cancellation” to return it.</p>}
            {refundOnCancel && <label className="field-label">Refund amount
              <div className="money-input"><span>{currency}</span><input inputMode="decimal" value={refundAmount} onChange={event => setRefundAmount(event.target.value)} aria-label="Refund amount with cancellation" /></div>
            </label>}
          </>}
          <label className="field-label">Reason <span className="optional-label">OPTIONAL</span><input maxLength={200} value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="Reason for cancellation" /></label>
          <div className="drawer-actions"><button className="button button-danger" onClick={() => void confirmCancellation()} disabled={busy}>{busy ? 'Cancelling…' : 'Confirm cancellation'}</button><button className="button button-quiet" onClick={() => setConfirmCancel(false)} disabled={busy}>Keep booking</button></div>
        </div>}
      </div>}

      {data.payments.length > 0 && <div className="action-section payment-history">
        <p className="section-index">CASH HISTORY <span>— {data.payments.length.toString().padStart(2, '0')}</span></p>
        {data.payments.map(payment => <div className="history-row" key={payment.id}>
          <span className={`history-sign ${payment.kind === 'refund' ? 'is-refund' : ''}`}>{payment.kind === 'refund' || payment.amountCents < 0 ? '−' : '+'}</span>
          <span><b>{payment.kind === 'refund' || payment.amountCents < 0 ? 'Refund' : 'Payment'}</b><small>{payment.receivedByName} · {formatDateTime(payment.createdAt, location?.timezone ?? 'UTC')}</small>{payment.note && <small>{payment.note}</small>}</span>
          <strong>{money(Math.abs(payment.amountCents), currency)}</strong>
        </div>)}
      </div>}
      {error && <div className="form-alert drawer-alert" role="alert"><span>{error}</span><button className="text-button" type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh details'}</button></div>}
      <button className="button button-quiet drawer-bottom-close" onClick={closeIfIdle} disabled={busy}>Close</button>
    </>}
  </Drawer>;
}
