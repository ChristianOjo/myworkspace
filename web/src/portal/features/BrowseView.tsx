import type { Availability, PortalLocation, PortalResource } from '../api/types';
import { EmptyState, InlineError, Loading } from '../../components/Feedback';
import { dateInZone, formatDate, money } from '../../lib/format';

const TYPE_LABELS: Record<string, string> = {
  desk: 'Hot desk',
  dedicated_desk: 'Dedicated desk',
  meeting_room: 'Meeting room',
  phone_booth: 'Phone booth',
  parking: 'Parking bay',
};

export function BrowseView({ orgName, locations, locationId, onLocationChange, date, onDateChange, resources, availability, loading, error, currency, onBook }: {
  orgName: string;
  locations: PortalLocation[];
  locationId: string;
  onLocationChange: (id: string) => void;
  date: string;
  onDateChange: (date: string) => void;
  resources: PortalResource[];
  availability: Availability | null;
  loading: boolean;
  error: string;
  currency: string;
  onBook: (resource: PortalResource) => void;
}) {
  const availabilityFor = (id: string) => availability?.resources.find(item => item.id === id) ?? null;
  const busyCount = (id: string) => {
    const entry = availabilityFor(id);
    if (!entry) return 0;
    return entry.intervals.filter(item => item.status !== 'cancelled').length + entry.blocks.length;
  };

  return <div className="page-body">
    <div className="page-heading portal-heading">
      <div>
        <p className="eyebrow">{orgName ? `${orgName.toUpperCase()} / BOOKING` : 'BOOKING'}</p>
        <h1>Choose a space</h1>
        <p className="muted">Live availability for the selected day. Bookings are confirmed online and paid at the front desk.</p>
      </div>
      <div className="heading-actions">
        {locations.length > 1 && <label className="field-label compact-field">Location
          <select value={locationId} onChange={event => onLocationChange(event.target.value)}>
            {locations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>}
        <label className="field-label compact-field">Date
          <input type="date" value={date} min={dateInZone()} onChange={event => onDateChange(event.target.value)} />
        </label>
      </div>
    </div>

    <p className="date-title-row" style={{ marginTop: 14 }}>
      <b>{formatDate(date)}</b>
    </p>

    {loading && <Loading label="Loading available spaces…" />}
    {error && !loading && <InlineError message={error} />}

    {!loading && !error && resources.length === 0 && (
      <EmptyState title="No spaces listed for this day" detail="Check another date or contact the front desk for availability." />
    )}

    {!loading && !error && resources.length > 0 && (
      <div className="portal-grid">
        {resources.map(resource => {
          const entry = availabilityFor(resource.id);
          const busy = busyCount(resource.id);
          const hasHourly = resource.hourlyRateCents > 0;
          const hasDay = resource.dayRateCents > 0;
          return <article key={resource.id} className="portal-card">
            <div className="portal-card-head">
              <span className="resource-label-mini">{TYPE_LABELS[resource.type] ?? resource.type}</span>
              {entry && busy > 0 ? <span className="status-badge status-confirmed"><span className="status-dot" aria-hidden="true" />Partly busy</span> : <span className="status-badge status-active"><span className="status-dot" aria-hidden="true" />Open today</span>}
            </div>
            <h3>{resource.name}</h3>
            {resource.capacity > 0 && <p className="muted">Capacity: {resource.capacity} {resource.capacity === 1 ? 'person' : 'people'}</p>}
            <div className="portal-rates">
              {hasHourly && <div><span>Hourly</span><b>{money(resource.hourlyRateCents, currency)}</b><small>per hour</small></div>}
              {hasDay && <div><span>Day rate</span><b>{money(resource.dayRateCents, currency)}</b><small>per day</small></div>}
              {!hasHourly && !hasDay && <p className="muted">Rates are set by the front desk.</p>}
            </div>
            <div className="portal-card-actions">
              <button className="button button-primary" disabled={!hasHourly && !hasDay} onClick={() => onBook(resource)}>
                Book this space <span aria-hidden="true">↗</span>
              </button>
            </div>
          </article>;
        })}
      </div>
    )}
  </div>;
}
