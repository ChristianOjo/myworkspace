import { useMemo, useState } from 'react';
import type { Booking, CreateBookingPayload, Location, Resource } from '../../api/types';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, InlineError, Loading } from '../../components/Feedback';
import { dateInZone, formatDate, isManager, minuteOfDay, minuteToClock, parseClock, statusLabel } from '../../lib/format';
import { BookingForm } from './BookingForm';

interface Props {
  location?: Location;
  locations: Location[];
  date: string;
  resources: Resource[];
  bookings: Booking[];
  role: string;
  loading: boolean;
  error: string;
  onDateChange: (value: string) => void;
  onLocationChange: (id: string) => void;
  onRefresh: () => void;
  onCreate: (payload: CreateBookingPayload) => Promise<void>;
  onSelectBooking: (id: string) => void;
  currency: string;
}

const LANE_PER_HOUR = 92;
const quarter = 15;

export function CalendarView(props: Props) {
  const { location, locations, date, resources, bookings, loading, error, onDateChange, onLocationChange, onRefresh, onCreate, onSelectBooking, currency } = props;
  const [form, setForm] = useState<{ resourceId: string; minute: number } | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const allVisible = useMemo(() => showRetired ? resources : resources.filter(resource => resource.status !== 'retired'), [resources, showRetired]);
  if (!location) {
    return <section className="page-body"><EmptyState title="No location available" detail="An organisation admin needs to add a location before the calendar can be used." /></section>;
  }

  const openMinute = parseClock(location.openHour);
  const closeMinute = parseClock(location.closeHour);
  const laneWidth = Math.max(1, (closeMinute - openMinute) / 60) * LANE_PER_HOUR;
  const now = new Date();
  const today = dateInZone(now, location.timezone);
  const isToday = date === today;
  const isPastDay = date < today;
  const nowMinute = isToday ? minuteOfDay(now.toISOString(), location.timezone) : -1;
  const nowX = (nowMinute - openMinute) / 60 * LANE_PER_HOUR;
  const firstOpenSlot = isToday ? Math.max(openMinute, Math.floor(nowMinute / quarter) * quarter) : openMinute;
  const canCreateInView = !isPastDay && closeMinute - openMinute >= 30 && (!isToday || firstOpenSlot + 30 <= closeMinute);
  const visibleBookings = bookings.filter(booking => ['confirmed', 'checked_in', 'completed', 'no_show'].includes(booking.status));
  const activeCount = visibleBookings.filter(item => item.status === 'confirmed' || item.status === 'checked_in').length;

  function startNew(resourceId: string, minute: number) {
    if (!resourceId || !canCreateInView) return;
    const rounded = Math.floor(minute / quarter) * quarter;
    const latestStart = closeMinute - 30;
    setForm({ resourceId, minute: Math.min(Math.max(rounded, firstOpenSlot), latestStart) });
  }

  return <section className="calendar-page page-body">
    <div className="page-heading calendar-heading">
      <div>
        <p className="eyebrow">SCHEDULE / {location.name.toUpperCase()}</p>
        <div className="date-title-row">
          <h1>{date === dateInZone(new Date(), location.timezone) ? 'Today' : formatDate(date)}</h1>
          <span className="today-clock"><span className="clock-marker" />{new Intl.DateTimeFormat('en', { timeZone: location.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)} LOCAL</span>
        </div>
        <p className="heading-note">{location.openHour}—{location.closeHour} <span className="dot-separator">·</span> {activeCount} active booking{activeCount === 1 ? '' : 's'}</p>
      </div>
      <div className="heading-actions">
        <label className="compact-field"><span>Location</span><select value={location.id} onChange={event => onLocationChange(event.target.value)} aria-label="Location">
          {locations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="compact-field"><span>Date</span><input aria-label="Schedule date" type="date" value={date} onChange={event => onDateChange(event.target.value)} /></label>
        <div className="date-stepper" aria-label="Change day">
          <button className="icon-button" title="Previous day" aria-label="Previous day" onClick={() => onDateChange(shiftDay(date, -1))}>←</button>
          <button className="icon-button" title="Next day" aria-label="Next day" onClick={() => onDateChange(shiftDay(date, 1))}>→</button>
        </div>
        <button className="button button-primary new-booking-button" onClick={() => startNew(allVisible.find(item => item.status === 'active')?.id ?? '', firstOpenSlot)} disabled={!allVisible.some(item => item.status === 'active') || !canCreateInView} title={!canCreateInView ? (isPastDay ? 'This day has passed.' : 'No 30-minute booking window remains within opening hours.') : undefined}><span aria-hidden="true">＋</span> New booking</button>
        <button className="button button-quiet refresh-button" onClick={onRefresh} disabled={loading} aria-label="Refresh schedule">↻</button>
      </div>
    </div>

    <div className="schedule-meta">
      <div className="legend" aria-label="Booking statuses">
        <span><i className="legend-mark legend-confirmed" />Booked</span>
        <span><i className="legend-mark legend-here" />Here now</span>
        <span><i className="legend-mark legend-complete" />Finished</span>
        <span><i className="legend-mark legend-noshow" />No-show</span>
      </div>
      {isManager(props.role) && <label className="check-inline retired-toggle"><input type="checkbox" checked={showRetired} onChange={event => setShowRetired(event.target.checked)} /> Include retired</label>}
    </div>

    {error && <InlineError message={error} onRetry={onRefresh} />}
    {loading && resources.length === 0 ? <Loading label="Loading today's schedule" /> : allVisible.length === 0 ?
      <EmptyState title="No resources yet" detail="Add desks and rooms in Setup to build the day schedule." /> :
      <div className="schedule-frame" aria-label={`Schedule for ${location.name} on ${date}`}>
        <div className="schedule-scroll">
          <div className="schedule-row schedule-header" style={{ minWidth: `${156 + laneWidth}px` }}>
            <div className="resource-label schedule-corner"><span>RESOURCE</span><b>{allVisible.length.toString().padStart(2, '0')}</b></div>
            <div className="time-track time-header" style={{ width: laneWidth }}>
              {Array.from({ length: Math.ceil((closeMinute - openMinute) / 60) + 1 }, (_, index) => {
                const minute = openMinute + index * 60;
                if (minute > closeMinute) return null;
                return <span key={minute} className="time-tick" style={{ left: (minute - openMinute) / 60 * LANE_PER_HOUR }}>{minuteToClock(minute)}</span>;
              })}
            </div>
          </div>
          {allVisible.map(resource => {
            const resourceBookings = visibleBookings.filter(item => item.resourceId === resource.id);
            const disabledResource = resource.status !== 'active';
            return <div className={`schedule-row ${disabledResource ? 'resource-unavailable' : ''}`} key={resource.id} style={{ minWidth: `${156 + laneWidth}px` }}>
              <div className="resource-label">
                <b>{resource.name}</b>
                <small>{resource.type.replaceAll('_', ' ')}</small>
                <span className="resource-rate">{resource.hourlyRateCents > 0 ? `${currency}${(resource.hourlyRateCents / 100).toFixed(2)}/h` : 'No hourly rate'}</span>
                {resource.status !== 'active' && <StatusBadge status={resource.status} />}
              </div>
              <div className={`time-track ${disabledResource ? 'time-track-disabled' : ''}`} style={{ width: laneWidth, backgroundSize: `${LANE_PER_HOUR}px 100%` }}>
                {isToday && nowMinute > openMinute && <span className="past-shade" style={{ width: Math.max(0, Math.min(nowX, laneWidth)) }} />}
                {!disabledResource && canCreateInView && <button type="button" className="time-track-hitarea" aria-label={`Open a booking for ${resource.name} on ${formatDate(date)}`} onClick={event => {
                  if (event.detail === 0) { startNew(resource.id, firstOpenSlot); return; }
                  const rect = event.currentTarget.getBoundingClientRect();
                  const relative = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left));
                  const minute = openMinute + Math.floor(relative / LANE_PER_HOUR * 4) * quarter;
                  startNew(resource.id, Math.min(minute, closeMinute - quarter));
                }} />}
                {resourceBookings.map(booking => {
                  const start = minuteOfDay(booking.start, location.timezone);
                  const end = minuteOfDay(booking.end, location.timezone);
                  const left = Math.max(0, (start - openMinute) / 60 * LANE_PER_HOUR);
                  const right = Math.min(laneWidth, (end - openMinute) / 60 * LANE_PER_HOUR);
                  const width = Math.max(52, right - left - 3);
                  return <button type="button" key={booking.id} className={`booking-block booking-${booking.status}`} style={{ left: Math.max(0, Math.min(left, laneWidth - 54)), width: Math.min(width, laneWidth - Math.max(left, 0)) }}
                    onClick={() => onSelectBooking(booking.id)} aria-label={`${booking.customerName}, ${statusLabel(booking.status)}, ${minuteToClock(start)} to ${minuteToClock(end)}, ${booking.paymentStatus}`}>
                    <b>{booking.customerName}</b><small><span>{minuteToClock(start)}–{minuteToClock(end)}</span><span>{statusLabel(booking.status)}</span></small>
                  </button>;
                })}
                {isToday && nowMinute >= openMinute && nowMinute <= closeMinute && <span className="now-marker" style={{ left: nowX }} aria-label="Current time" />}
              </div>
            </div>;
          })}
        </div>
      </div>}
    <div className="calendar-footnote"><span>{isPastDay ? 'This day has passed, so new bookings can’t be added. Tap a booking to view it.' : 'Tap an open time to book. Tap a booking to manage it.'}</span><span>{location.timezone}</span></div>

    <BookingForm open={!!form} date={date} timezone={location.timezone} location={location} resources={resources} initialResourceId={form?.resourceId ?? ''} initialMinute={form?.minute ?? openMinute} now={now} currency={currency} onClose={() => setForm(null)} onSubmit={onCreate} />
  </section>;
}

function shiftDay(day: string, amount: number): string {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
