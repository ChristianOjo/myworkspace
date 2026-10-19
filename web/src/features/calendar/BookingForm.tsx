import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CreateBookingPayload, Location, Resource } from '../../api/types';
import { Drawer } from '../../components/Drawer';
import { friendlyError } from '../../lib/errors';
import { money, parseClock, wallTimeToIso } from '../../lib/format';

const durations = [30, 60, 90, 120, 180, 240, 480];
const labelDuration = (minutes: number) => minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;

export function BookingForm({ open, date, timezone, location, resources, initialResourceId, initialMinute, now, currency, onClose, onSubmit }: {
  open: boolean;
  date: string;
  timezone: string;
  location: Location;
  resources: Resource[];
  initialResourceId: string;
  initialMinute: number;
  now: Date;
  currency: string;
  onClose: () => void;
  onSubmit: (payload: CreateBookingPayload) => Promise<void>;
}) {
  const [kind, setKind] = useState<'hourly' | 'day'>('hourly');
  const [resourceId, setResourceId] = useState(initialResourceId);
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(60);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [arrivedNow, setArrivedNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    setKind('hourly');
    setResourceId(initialResourceId || resources.find(item => item.status === 'active')?.id || '');
    setStart(minuteToClockSafe(initialMinute));
    setDuration(60);
    setName('');
    setPhone('');
    setArrivedNow(false);
    setError('');
    setBusy(false);
    inFlight.current = false;
  }, [open, date, initialResourceId, initialMinute]);

  const resource = useMemo(() => resources.find(item => item.id === resourceId), [resources, resourceId]);
  const localStart = kind === 'day' ? location.openHour : start;
  const startIso = localStart ? wallTimeToIso(date, localStart, timezone) : '';
  const endTime = localStart ? minuteToClockSafe(parseClock(localStart) + duration) : '';
  const endIso = endTime ? wallTimeToIso(date, endTime, timezone) : '';
  const isStarted = startIso ? new Date(startIso).getTime() <= now.getTime() : false;
  const dayPrice = resource?.dayRateCents ?? 0;
  const price = kind === 'day' ? dayPrice : resource ? Math.round(resource.hourlyRateCents * duration / 60) : 0;
  const closed = kind === 'hourly' && parseClock(start || '00:00') + duration > parseClock(location.closeHour);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    setError('');
    if (!resource || resource.status !== 'active') {
      setError('Choose an active desk or room.');
      return;
    }
    if (!name.trim()) {
      setError('Enter the customer’s name.');
      return;
    }
    if (kind === 'day' && dayPrice <= 0) {
      setError('A day booking is not offered for this resource.');
      return;
    }
    if (closed) {
      setError(`That booking runs past closing at ${location.closeHour}. Choose an earlier time or shorter duration.`);
      return;
    }
    if (arrivedNow && !isStarted) {
      setError('A customer can only be marked here once the booking has started.');
      return;
    }

    const payload: CreateBookingPayload = {
      resourceId,
      customerName: name.trim(),
      ...(phone.trim() ? { customerPhone: phone.trim() } : {}),
      ...(arrivedNow ? { arrivedNow: true as const } : {}),
      ...(kind === 'day' ? { kind: 'day' as const, date } : { start: startIso, end: endIso }),
    };
    inFlight.current = true;
    setBusy(true);
    try {
      await onSubmit(payload);
      onClose();
    } catch (cause) {
      setError(friendlyError(cause, 'The booking could not be created. Please check the details and try again.'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const activeResources = resources.filter(item => item.status === 'active');
  return <Drawer open={open} title="New booking" onClose={onClose}>
    <div className="drawer-head"><p className="eyebrow">NEW / {date}</p><h2>New booking</h2><p className="muted">{location.name} <span className="dot-separator">·</span> {timezone}</p></div>
    <form className="form-stack drawer-form" onSubmit={submit}>
      <div className="segmented-control" role="group" aria-label="Booking length">
        <button type="button" className={kind === 'hourly' ? 'is-selected' : ''} aria-pressed={kind === 'hourly'} onClick={() => { setKind('hourly'); setError(''); }}>By the hour</button>
        <button type="button" className={kind === 'day' ? 'is-selected' : ''} aria-pressed={kind === 'day'} onClick={() => { setKind('day'); setError(''); }}>Whole day</button>
      </div>
      <label className="field-label">Desk or room
        <select required value={resourceId} onChange={event => setResourceId(event.target.value)}>
          <option value="">Choose a resource</option>
          {activeResources.map(item => <option key={item.id} value={item.id}>{item.name} — {money(item.hourlyRateCents, currency)}/hr</option>)}
        </select>
      </label>
      {kind === 'day' ? <div className="form-note"><span className="note-index">DAY</span> Runs {location.openHour}–{location.closeHour} at the flat day rate.</div> : <div className="form-grid-two">
        <label className="field-label">Starts
          <select value={start} onChange={event => setStart(event.target.value)}>
            {timeSlots(location.openHour, location.closeHour).map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="field-label">Duration
          <select value={duration} onChange={event => setDuration(Number(event.target.value))}>
            {durations.map(value => <option key={value} value={value}>{labelDuration(value)}</option>)}
          </select>
        </label>
      </div>}
      <label className="field-label">Customer name
        <input required maxLength={200} value={name} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="Full name" />
      </label>
      <label className="field-label">Phone <span className="optional-label">OPTIONAL</span>
        <input maxLength={50} value={phone} onChange={event => setPhone(event.target.value)} autoComplete="off" inputMode="tel" placeholder="Contact number" />
      </label>
      <label className={`walkin-option ${!isStarted ? 'is-disabled' : ''}`}>
        <input type="checkbox" checked={arrivedNow} disabled={!isStarted} onChange={event => setArrivedNow(event.target.checked)} />
        <span><b>Customer is here now</b><small>{isStarted ? 'Create as already checked in.' : 'Available once the booking has started.'}</small></span>
      </label>
      <div className="price-preview"><span>ESTIMATED PRICE</span><b>{money(price, currency)}</b><small>{kind === 'day' ? 'Flat day rate' : `${money(resource ? resource.hourlyRateCents : 0, currency)} × ${labelDuration(duration)}`}</small></div>
      {error && <div className="form-alert" role="alert">{error}</div>}
      <div className="drawer-actions"><button className="button button-primary" type="submit" disabled={busy || !activeResources.length}>{busy ? 'Booking…' : 'Confirm booking'}<span aria-hidden="true">↗</span></button><button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button></div>
      <p className="small-note">The server checks availability, rates and booking rules before saving.</p>
    </form>
  </Drawer>;
}

function timeSlots(open: string, close: string): string[] {
  const start = parseClock(open);
  const end = parseClock(close);
  const result: string[] = [];
  for (let value = start; value < end; value += 15) result.push(minuteToClockSafe(value));
  return result.length ? result : [open];
}

function minuteToClockSafe(value: number): string {
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
