import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Drawer } from '../../components/Drawer';
import type { AvailabilityResource, PortalLocation, PortalResource } from '../api/types';
import type { CreateMyBookingPayload } from '../api/types';
import { friendlyError } from '../lib/errors';
import { minuteOfDay, money, parseClock, wallTimeToIso } from '../../lib/format';

const durations = [30, 60, 90, 120, 180, 240];
const labelDuration = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;

function minuteToClock(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function BookingDrawer({ open, resource, location, date, availability, profileName, defaultPhone, currency, onClose, onSubmit }: {
  open: boolean;
  resource: PortalResource | null;
  location: PortalLocation;
  date: string;
  availability: AvailabilityResource | null;
  profileName: string;
  defaultPhone: string;
  currency: string;
  onClose: () => void;
  onSubmit: (payload: CreateMyBookingPayload, phone: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<'hourly' | 'day'>('hourly');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(60);
  const [phone, setPhone] = useState(defaultPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind('hourly');
    setStart('');
    setDuration(60);
    setPhone(defaultPhone);
    setError('');
    setBusy(false);
  }, [open, resource?.id, defaultPhone]);

  const timezone = location.timezone;

  const busyRanges = useMemo(() => {
    if (!availability) return [];
    const windows = [
      ...availability.intervals.map((item) => ({ start: minuteOfDay(item.start, timezone), end: minuteOfDay(item.end, timezone) })),
      ...availability.blocks.map((item) => ({ start: minuteOfDay(item.start, timezone), end: minuteOfDay(item.end, timezone) })),
    ];
    return windows.filter((item) => item.end > item.start);
  }, [availability, timezone]);

  const overlapsBusy = (startMinute: number, lengthMinutes: number): boolean =>
    busyRanges.some((item) => item.start < startMinute + lengthMinutes && item.end > startMinute);

  const startOptions = useMemo(() => {
    const open = parseClock(location.openHour);
    const close = parseClock(location.closeHour);
    const options: { value: string; disabled: boolean; reason: string }[] = [];
    const now = new Date();
    const today = new Date().toISOString().slice(0, 10);
    for (let value = open; value < close; value += 15) {
      const clock = minuteToClock(value);
      let disabled = false;
      let reason = '';
      if (date === today) {
        const zoneNowMinute = minuteOfDay(now.toISOString(), timezone);
        if (value <= zoneNowMinute) { disabled = true; reason = 'Past'; }
      }
      if (!disabled && overlapsBusy(value, duration)) { disabled = true; reason = 'Busy'; }
      if (!disabled && value + duration > close) { disabled = true; reason = 'Past closing'; }
      options.push({ value: clock, disabled, reason });
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.openHour, location.closeHour, timezone, date, duration, busyRanges]);

  const dayPrice = resource?.dayRateCents ?? 0;
  const hourlyPrice = kind === 'hourly' && resource ? Math.round((resource.hourlyRateCents * duration) / 60) : 0;
  const price = kind === 'day' ? dayPrice : hourlyPrice;

  const closedPastClosing = kind === 'hourly' && start
    ? parseClock(start) + duration > parseClock(location.closeHour)
    : false;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resource) return;
    setError('');

    if (kind === 'hourly') {
      if (!start) { setError('Choose a start time.'); return; }
      if (closedPastClosing) { setError(`That booking runs past closing at ${location.closeHour}. Choose an earlier time.`); return; }
      const startIso = wallTimeToIso(date, start, timezone);
      const endClock = minuteToClock(parseClock(start) + duration);
      const endIso = wallTimeToIso(date, endClock, timezone);
      const payload: CreateMyBookingPayload = { resourceId: resource.id, kind: 'hourly', start: startIso, end: endIso, ...(phone.trim() ? { phone: phone.trim() } : {}) };
      await runSubmit(payload);
    } else {
      if (dayPrice <= 0) { setError('Whole-day booking is not offered for this space.'); return; }
      const payload: CreateMyBookingPayload = { resourceId: resource.id, kind: 'day', date, ...(phone.trim() ? { phone: phone.trim() } : {}) };
      await runSubmit(payload);
    }
  }

  async function runSubmit(payload: CreateMyBookingPayload) {
    setBusy(true);
    try {
      await onSubmit(payload, phone.trim());
      onClose();
    } catch (cause) {
      setError(friendlyError(cause, 'The booking could not be created. Please check the details and try again.'));
    } finally {
      setBusy(false);
    }
  }

  return <Drawer open={open} title="Book this space" onClose={onClose}>
    {resource && <>
      <div className="drawer-head">
        <p className="eyebrow">{resource.type.replace('_', ' ').toUpperCase()} / {date}</p>
        <h2>{resource.name}</h2>
        <p className="muted">{location.name} <span className="dot-separator">·</span> Open {location.openHour}–{location.closeHour} <span className="dot-separator">·</span> {timezone}</p>
      </div>
      <form className="form-stack drawer-form" onSubmit={submit}>
        <div className="segmented-control" role="group" aria-label="Booking length">
          <button type="button" className={kind === 'hourly' ? 'is-selected' : ''} aria-pressed={kind === 'hourly'} onClick={() => { setKind('hourly'); setError(''); }}>By the hour</button>
          <button type="button" className={kind === 'day' ? 'is-selected' : ''} aria-pressed={kind === 'day'} onClick={() => { setKind('day'); setError(''); }}>Whole day</button>
        </div>

        {kind === 'hourly' ? <div className="form-grid-two">
          <label className="field-label">Starts
            <select required value={start} onChange={event => setStart(event.target.value)}>
              <option value="">Choose a time</option>
              {startOptions.map(option => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.value}{option.disabled ? ` — ${option.reason}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">Duration
            <select value={duration} onChange={event => setDuration(Number(event.target.value))}>
              {durations.map(value => <option key={value} value={value}>{labelDuration(value)}</option>)}
            </select>
          </label>
        </div> : <div className="form-note"><span className="note-index">DAY</span> Runs {location.openHour}–{location.closeHour} at the flat day rate.</div>}

        <label className="field-label">Booking for
          <input readOnly value={profileName} className="read-only-field" />
        </label>
        <label className="field-label">Contact phone <span className="optional-label">OPTIONAL</span>
          <input maxLength={50} inputMode="tel" value={phone} onChange={event => setPhone(event.target.value)} autoComplete="tel" placeholder="Where can we reach you?" />
        </label>

        <div className="price-preview">
          <span>ESTIMATED PRICE</span>
          <b>{money(price, currency)}</b>
          <small>{kind === 'day' ? 'Flat day rate, payable at the desk' : `${money(resource.hourlyRateCents, currency)} × ${labelDuration(duration)}, payable at the desk`}</small>
        </div>

        {error && <div className="form-alert" role="alert">{error}</div>}
        <div className="drawer-actions">
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Booking…' : 'Confirm booking'}<span aria-hidden="true">↗</span></button>
          <button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <p className="small-note">Availability and rates are checked by the server before the booking is saved. Payment is collected at the front desk on arrival.</p>
      </form>
    </>}
  </Drawer>;
}
