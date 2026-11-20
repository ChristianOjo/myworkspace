import { useState } from 'react';
import type { MyBooking } from '../api/types';
import { EmptyState, InlineError, Loading } from '../../components/Feedback';
import { formatDateTime, money } from '../../lib/format';

const STATUS_LABELS: Record<string, string> = {
  pending_payment: 'Pending payment',
  confirmed: 'Booked',
  checked_in: 'Here now',
  completed: 'Finished',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

export function BookingsView({ bookings, loading, error, currency, busyId, onCancel, onRetry }: {
  bookings: MyBooking[];
  loading: boolean;
  error: string;
  currency: string;
  busyId: string | null;
  onCancel: (booking: MyBooking) => Promise<void>;
  onRetry: () => void;
}) {
  return <div className="page-body">
    <div className="page-heading">
      <div>
        <p className="eyebrow">YOUR BOOKINGS</p>
        <h1>My bookings</h1>
        <p className="muted">Upcoming reservations appear first. Cancel a confirmed, unpaid booking before it starts.</p>
      </div>
    </div>

    {loading && <Loading label="Loading your bookings…" />}
    {error && !loading && <InlineError message={error} onRetry={onRetry} />}
    {!loading && !error && bookings.length === 0 && (
      <EmptyState title="No bookings yet" detail="Browse available spaces and make your first reservation." />
    )}

    {!loading && !error && bookings.length > 0 && <div className="portal-list">
      {bookings.map(booking => <BookingRow
        key={booking.id}
        booking={booking}
        currency={currency}
        busy={busyId === booking.id}
        onCancel={onCancel}
      />)}
    </div>}
  </div>;
}

function BookingRow({ booking, currency, busy, onCancel }: {
  booking: MyBooking;
  currency: string;
  busy: boolean;
  onCancel: (booking: MyBooking) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const cancelled = booking.status === 'cancelled';
  const ended = booking.status === 'completed' || booking.status === 'no_show';

  return <article className={`portal-list-row ${cancelled ? 'is-cancelled' : ''}`}>
    <div className="portal-list-main">
      <div className="portal-list-title">
        <b>{booking.resourceName}</b>
        <span className={`status-badge status-${booking.status}`}><span className="status-dot" aria-hidden="true" />{STATUS_LABELS[booking.status] ?? booking.status}</span>
      </div>
      <p className="muted">
        {booking.pricing === 'day' ? 'Whole day' : 'Hourly'} · {booking.locationName}
      </p>
      <p className="portal-list-time">
        {booking.pricing === 'day'
          ? formatDateTime(booking.start, booking.timezone, { dateStyle: 'full' })
          : `${formatDateTime(booking.start, booking.timezone)} – ${formatDateTime(booking.end, booking.timezone)}`}
      </p>
    </div>
    <div className="portal-list-side">
      <div className="portal-list-price">
        <small>{booking.pricing === 'day' ? 'Day rate' : 'Price'}</small>
        <b>{money(booking.priceCents, currency)}</b>
      </div>
      {booking.cancelable && !confirming && (
        <button className="text-button danger-text" disabled={busy} onClick={() => setConfirming(true)}>Cancel booking</button>
      )}
      {confirming && (
        <div className="cancel-confirmation">
          <p>Cancel this reservation? This cannot be undone.</p>
          <div className="block-actions">
            <button className="button button-danger" disabled={busy} onClick={() => void onCancel(booking)}>{busy ? 'Cancelling…' : 'Yes, cancel'}</button>
            <button className="button button-quiet" disabled={busy} onClick={() => setConfirming(false)}>Keep booking</button>
          </div>
        </div>
      )}
      {(ended || cancelled) && !booking.cancelable && <span className="muted portal-list-note">No actions available.</span>}
    </div>
  </article>;
}
