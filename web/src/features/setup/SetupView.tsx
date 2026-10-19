import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Location, MaintenanceBlock, Resource, ResourceStatus, ResourceType, Role, StaffMember, User } from '../../api/types';
import { createBlock, createLocation, createResource, createStaff, deactivateStaff, deleteBlock, listBlocks, listStaff, resetStaffPassword, updateLocation, updateResource } from '../../api/routes';
import { EmptyState, InlineError, Loading } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import { friendlyError } from '../../lib/errors';
import { formatDateTime, money, parseMoneyToCents, wallTimeToIso } from '../../lib/format';

const roles: Role[] = ['member', 'location_manager', 'org_admin'];
const resourceTypes: ResourceType[] = ['desk', 'dedicated_desk', 'meeting_room', 'phone_booth', 'parking'];
const resourceStatuses: ResourceStatus[] = ['active', 'maintenance', 'retired'];
type Section = 'staff' | 'locations' | 'resources' | 'maintenance';

export function SetupView({ role, user, locations, resources, currency, onLocationsChanged, onResourcesChanged, notify }: {
  role: Role;
  user: User;
  locations: Location[];
  resources: Resource[];
  currency: string;
  onLocationsChanged: () => void;
  onResourcesChanged: () => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
}) {
  const admin = role === 'org_admin';
  const [section, setSection] = useState<Section>('staff');
  const allSections: { id: Section; label: string; hint: string }[] = [
    { id: 'staff', label: 'Staff', hint: '01' }, { id: 'locations', label: 'Locations', hint: '02' },
    { id: 'resources', label: 'Resources & rates', hint: '03' }, { id: 'maintenance', label: 'Maintenance', hint: '04' },
  ];
  const sections = admin ? allSections : [
    { id: 'staff' as const, label: 'Staff', hint: '01' },
    { id: 'maintenance' as const, label: 'Maintenance', hint: '02' },
  ];
  useEffect(() => {
    if (!admin && (section === 'locations' || section === 'resources')) setSection('staff');
  }, [admin, section]);

  return <section className="page-body setup-page">
    <div className="page-heading"><div><p className="eyebrow">CONFIGURATION / OPERATIONS</p><h1>Setup</h1><p className="heading-note">Keep people, spaces, rates and maintenance windows in order.</p></div>
      <div className="role-stamp">{admin ? 'ORG ADMIN' : 'LOCATION MANAGER'}<span>SERVER-ENFORCED ACCESS</span></div>
    </div>
    <div className="setup-layout">
      <nav className="setup-nav" aria-label="Setup sections">
        {sections.map(item => <button key={item.id} className={section === item.id ? 'is-current' : ''} onClick={() => setSection(item.id)} aria-current={section === item.id ? 'page' : undefined}><span>{item.hint}</span>{item.label}<b aria-hidden="true">↗</b></button>)}
        <div className="setup-nav-note">Role permissions follow your signed-in account.</div>
      </nav>
      <div className="setup-content">
        {section === 'staff' && <StaffSection role={role} user={user} notify={notify} />}
        {section === 'locations' && admin && <LocationsSection admin={admin} locations={locations} onChanged={onLocationsChanged} notify={notify} />}
        {section === 'resources' && admin && <ResourcesSection admin={admin} locations={locations} resources={resources} currency={currency} onChanged={onResourcesChanged} notify={notify} />}
        {section === 'maintenance' && <MaintenanceSection role={role} locations={locations} resources={resources} currency={currency} notify={notify} />}
      </div>
    </div>
  </section>;
}

function StaffSection({ role, user, notify }: { role: Role; user: User; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const admin = role === 'org_admin';
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');
  const [password, setPassword] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError('');
    try { setStaff((await listStaff()).staff); }
    catch (cause) { setError(friendlyError(cause, 'Could not load staff accounts.')); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function addStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await createStaff(email.trim(), fullName.trim(), newRole, password);
      setEmail(''); setFullName(''); setNewRole('member'); setPassword('');
      await load(); notify('Staff account created.');
    } catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  async function deactivate(id: string) {
    setBusy(true); setError('');
    try {
      await deactivateStaff(id); setConfirmDeactivate(null); await load(); notify('Staff account deactivated. Their sessions have ended.');
    } catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  async function resetPassword(id: string, nextPassword: string, reset: () => void) {
    if (nextPassword.length < 10) { setError('Use a password with at least 10 characters.'); return; }
    setBusy(true); setError('');
    try { await resetStaffPassword(id, nextPassword); reset(); notify('Staff password reset.'); }
    catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="setup-section">
    <div className="setup-section-head"><div><p className="eyebrow">PEOPLE / ACCESS</p><h2>Staff</h2><p className="muted">{admin ? 'Create and manage staff access.' : 'Staff account directory. Account changes require an organisation admin.'}</p></div><button className="button button-quiet" onClick={() => void load()} disabled={loading}>↻ Refresh</button></div>
    {error && <InlineError message={error} />}
    {loading ? <Loading label="Loading staff" /> : staff.length === 0 ? <EmptyState title="No staff accounts found" detail="Create the first staff account to grant front-desk access." /> :
      <div className="staff-list">
        {staff.map(member => <article className={`staff-row ${member.deactivatedAt ? 'staff-deactivated' : ''}`} key={member.id}>
          <div className="staff-initials" aria-hidden="true">{initials(member.fullName)}</div>
          <div className="staff-identity"><b>{member.fullName}{member.id === user.id && <span className="you-label">YOU</span>}</b><span>{member.email}</span><small>{roleLabel(member.role)}{member.deactivatedAt ? ' · Deactivated' : ''}</small></div>
          <div className="staff-actions">
            <StatusBadge status={member.deactivatedAt ? 'retired' : 'active'} />
            {admin && !member.deactivatedAt && member.id !== user.id && <>
              <details className="row-more"><summary className="icon-button" aria-label={`More actions for ${member.fullName}`}>···</summary><div className="row-menu">
                <PasswordResetForm busy={busy} onSubmit={newPassword => resetPassword(member.id, newPassword, () => undefined)} />
                {confirmDeactivate === member.id ? <div className="deactivate-confirm"><small>This ends their sessions. There is no reactivate action in the API.</small><button className="text-button danger-text" onClick={() => void deactivate(member.id)} disabled={busy}>Confirm deactivate</button><button className="text-button" onClick={() => setConfirmDeactivate(null)}>Keep active</button></div> : <button className="text-button danger-text" onClick={() => setConfirmDeactivate(member.id)}>Deactivate staff</button>}
              </div></details>
            </>}
          </div>
        </article>)}
      </div>}
    {admin && <form className="setup-form-card" onSubmit={addStaff}>
      <div className="setup-form-heading"><span className="section-index">ADD STAFF</span><span>Passwords are never displayed after saving.</span></div>
      <div className="setup-form-grid">
        <label className="field-label">Full name<input required maxLength={200} value={fullName} onChange={event => setFullName(event.target.value)} /></label>
        <label className="field-label">Email<input required type="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label className="field-label">Role<select value={newRole} onChange={event => setNewRole(event.target.value as Role)}>{roles.map(item => <option key={item} value={item}>{roleLabel(item)}</option>)}</select></label>
        <label className="field-label">Temporary password<input required minLength={10} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" /></label>
      </div>
      <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create staff account'}<span aria-hidden="true">↗</span></button>
    </form>}
  </div>;
}

function PasswordResetForm({ busy, onSubmit }: { busy: boolean; onSubmit: (password: string) => void }) {
  const [value, setValue] = useState('');
  return <form className="password-reset-form" onSubmit={event => { event.preventDefault(); onSubmit(value); setValue(''); }}>
    <label className="field-label">Reset password<input type="password" minLength={10} required autoComplete="new-password" value={value} onChange={event => setValue(event.target.value)} placeholder="At least 10 characters" /></label>
    <button className="text-button" type="submit" disabled={busy}>Set new password</button>
  </form>;
}

function LocationsSection({ admin, locations, onChanged, notify }: { admin: boolean; locations: Location[]; onChanged: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Africa/Johannesburg');
  const [openHour, setOpenHour] = useState('08:00');
  const [closeHour, setCloseHour] = useState('18:00');
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try { await createLocation({ name: name.trim(), timezone: timezone.trim(), openHour, closeHour }); setName(''); await onChanged(); notify('Location created.'); }
    catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="setup-section">
    <div className="setup-section-head"><div><p className="eyebrow">PLACES / HOURS</p><h2>Locations</h2><p className="muted">Opening hours are local to each location.</p></div></div>
    {error && <InlineError message={error} />}
    {locations.length === 0 ? <EmptyState title="No locations yet" detail="Add the first location to start a schedule." /> : <div className="location-list">
      {locations.map(location => <article className="location-card" key={location.id}>
        {editId === location.id ? <LocationEdit location={location} busy={busy} cancel={() => setEditId(null)} save={async values => {
          setBusy(true); setError('');
          try { await updateLocation(location.id, values); setEditId(null); await onChanged(); notify('Location updated.'); }
          catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
          finally { setBusy(false); }
        }} /> : <>
          <div className="location-card-head"><span className="location-index">LOC / {String(locations.indexOf(location) + 1).padStart(2, '0')}</span>{admin && <button className="text-button" onClick={() => setEditId(location.id)}>Edit location</button>}</div>
          <h3>{location.name}</h3><div className="location-details"><span><small>TIMEZONE</small>{location.timezone}</span><span><small>OPEN</small>{location.openHour}—{location.closeHour}</span></div>
        </>}
      </article>)}
    </div>}
    {admin && <form className="setup-form-card" onSubmit={add}>
      <div className="setup-form-heading"><span className="section-index">ADD LOCATION</span><span>Timezone must be an IANA name.</span></div>
      <div className="setup-form-grid"><label className="field-label">Location name<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Main" /></label><label className="field-label">Timezone<input list="timezone-list" required value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Africa/Johannesburg" /><datalist id="timezone-list"><option value="Africa/Johannesburg" /><option value="UTC" /><option value="Europe/London" /><option value="America/New_York" /></datalist></label><label className="field-label">Opens<input type="time" step="900" required value={openHour} onChange={event => setOpenHour(event.target.value)} /></label><label className="field-label">Closes<input type="time" step="900" required value={closeHour} onChange={event => setCloseHour(event.target.value)} /></label></div>
      <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add location'}<span aria-hidden="true">↗</span></button>
    </form>}
    {!admin && <div className="permission-note">Only an organisation admin can add or change locations.</div>}
  </div>;
}

function LocationEdit({ location, busy, cancel, save }: { location: Location; busy: boolean; cancel: () => void; save: (values: Partial<Pick<Location, 'name' | 'timezone' | 'openHour' | 'closeHour'>>) => void }) {
  const [name, setName] = useState(location.name);
  const [timezone, setTimezone] = useState(location.timezone);
  const [openHour, setOpenHour] = useState(location.openHour);
  const [closeHour, setCloseHour] = useState(location.closeHour);
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void save({ name: name.trim(), timezone: timezone.trim(), openHour, closeHour }); }}>
    <label className="field-label">Name<input required value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="field-label">Timezone<input required value={timezone} onChange={event => setTimezone(event.target.value)} /></label>
    <div className="form-grid-two"><label className="field-label">Opens<input type="time" step="900" value={openHour} onChange={event => setOpenHour(event.target.value)} /></label><label className="field-label">Closes<input type="time" step="900" value={closeHour} onChange={event => setCloseHour(event.target.value)} /></label></div>
    <div className="drawer-actions"><button className="button button-primary" disabled={busy}>Save changes</button><button className="button button-quiet" type="button" onClick={cancel} disabled={busy}>Cancel</button></div>
  </form>;
}

function ResourcesSection({ admin, locations, resources, currency, onChanged, notify }: { admin: boolean; locations: Location[]; resources: Resource[]; currency: string; onChanged: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [name, setName] = useState('');
  const [type, setType] = useState<ResourceType>('desk');
  const [capacity, setCapacity] = useState('');
  const [hourly, setHourly] = useState('');
  const [day, setDay] = useState('');
  const [status, setStatus] = useState<ResourceStatus>('active');
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentResources = useMemo(() => resources.filter(resource => resource.locationId === locationId), [resources, locationId]);
  useEffect(() => { if (!locations.some(item => item.id === locationId) && locations[0]) setLocationId(locations[0].id); }, [locations, locationId]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await createResource({ locationId, name: name.trim(), type, ...(capacity.trim() ? { capacity: Number(capacity) } : {}), hourlyRateCents: parseMoneyToCents(hourly), dayRateCents: day.trim() ? parseMoneyToCents(day) : 0, status });
      setName(''); setType('desk'); setCapacity(''); setHourly(''); setDay(''); setStatus('active'); await onChanged(); notify('Resource created.');
    } catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="setup-section">
    <div className="setup-section-head"><div><p className="eyebrow">INVENTORY / PRICING</p><h2>Resources &amp; rates</h2><p className="muted">Rates apply to new bookings only. Existing bookings keep their saved price.</p></div><label className="compact-field"><span>Location</span><select value={locationId} onChange={event => setLocationId(event.target.value)}>{locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label></div>
    {error && <InlineError message={error} />}
    {currentResources.length === 0 ? <EmptyState title="No resources at this location" detail="Add desks, meeting rooms, or other bookable spaces." /> : <div className="resource-list">
      {currentResources.map(resource => <article className="resource-card" key={resource.id}>
        {editId === resource.id ? <ResourceEdit resource={resource} busy={busy} currency={currency} cancel={() => setEditId(null)} save={async values => {
          setBusy(true); setError('');
          try {
            const result = await updateResource(resource.id, values); setEditId(null); await onChanged();
            if (typeof result.activeFutureBookings === 'number' && result.activeFutureBookings > 0) notify(`Resource updated. ${result.activeFutureBookings} upcoming booking${result.activeFutureBookings === 1 ? '' : 's'} may need to be moved or cancelled.`);
            else notify('Resource updated.');
          } catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
          finally { setBusy(false); }
        }} /> : <>
          <div className="resource-card-head"><span className="location-index">{resource.type.replaceAll('_', ' ').toUpperCase()}</span><StatusBadge status={resource.status} />{admin && <button className="text-button" onClick={() => setEditId(resource.id)}>Edit</button>}</div>
          <h3>{resource.name}</h3><div className="resource-details"><span><small>HOURLY</small>{money(resource.hourlyRateCents, currency)}</span><span><small>DAY</small>{resource.dayRateCents > 0 ? money(resource.dayRateCents, currency) : 'Not offered'}</span><span><small>CAPACITY</small>{resource.capacity ?? '—'}</span></div>
        </>}
      </article>)}
    </div>}
    {admin && <form className="setup-form-card" onSubmit={add}>
      <div className="setup-form-heading"><span className="section-index">ADD RESOURCE</span><span>Day rate 0 means day passes are not offered.</span></div>
      <div className="setup-form-grid">
        <label className="field-label">Name<input required maxLength={200} value={name} onChange={event => setName(event.target.value)} placeholder="Desk 01" /></label>
        <label className="field-label">Type<select value={type} onChange={event => setType(event.target.value as ResourceType)}>{resourceTypes.map(item => <option key={item} value={item}>{item.replaceAll('_', ' ')}</option>)}</select></label>
        <label className="field-label">Capacity <span className="optional-label">OPTIONAL</span><input type="number" min="1" max="1000" value={capacity} onChange={event => setCapacity(event.target.value)} /></label>
        <label className="field-label">Hourly rate<input required inputMode="decimal" value={hourly} onChange={event => setHourly(event.target.value)} placeholder={`${currency}0.00`} /></label>
        <label className="field-label">Day rate<input inputMode="decimal" value={day} onChange={event => setDay(event.target.value)} placeholder="0.00 = not offered" /></label>
        <label className="field-label">Status<select value={status} onChange={event => setStatus(event.target.value as ResourceStatus)}>{resourceStatuses.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      </div>
      <button className="button button-primary" type="submit" disabled={busy || !locationId}>{busy ? 'Saving…' : 'Add resource'}<span aria-hidden="true">↗</span></button>
    </form>}
    {!admin && <div className="permission-note">Only an organisation admin can create or edit resources and rates.</div>}
  </div>;
}

function ResourceEdit({ resource, busy, currency, cancel, save }: { resource: Resource; busy: boolean; currency: string; cancel: () => void; save: (values: Partial<Pick<Resource, 'name' | 'capacity' | 'hourlyRateCents' | 'dayRateCents' | 'status'>>) => void }) {
  const [name, setName] = useState(resource.name);
  const [capacity, setCapacity] = useState(resource.capacity ? String(resource.capacity) : '');
  const [hourly, setHourly] = useState((resource.hourlyRateCents / 100).toFixed(2));
  const [day, setDay] = useState((resource.dayRateCents / 100).toFixed(2));
  const [status, setStatus] = useState(resource.status);
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void save({ name: name.trim(), ...(capacity ? { capacity: Number(capacity) } : {}), hourlyRateCents: parseMoneyToCents(hourly), dayRateCents: parseMoneyToCents(day), status }); }}>
    <label className="field-label">Name<input required value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="form-grid-two"><label className="field-label">Hourly rate<input inputMode="decimal" value={hourly} onChange={event => setHourly(event.target.value)} /></label><label className="field-label">Day rate<input inputMode="decimal" value={day} onChange={event => setDay(event.target.value)} placeholder={`${currency}0.00`} /></label></div>
    <div className="form-grid-two"><label className="field-label">Capacity<input type="number" min="1" max="1000" value={capacity} onChange={event => setCapacity(event.target.value)} /><small className="field-hint">A blank value is omitted from the update.</small></label><label className="field-label">Status<select value={status} onChange={event => setStatus(event.target.value as ResourceStatus)}>{resourceStatuses.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>
    {status === 'retired' && resource.status !== 'retired' && <p className="warning-note">Retiring does not cancel upcoming bookings. Check the server response for bookings staff still need to move or cancel.</p>}
    <div className="drawer-actions"><button className="button button-primary" disabled={busy}>Save resource</button><button className="button button-quiet" type="button" onClick={cancel} disabled={busy}>Cancel</button></div>
  </form>;
}

function MaintenanceSection({ role, locations, resources, currency, notify }: { role: Role; locations: Location[]; resources: Resource[]; currency: string; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const manager = role === 'location_manager' || role === 'org_admin';
  const [resourceId, setResourceId] = useState(resources[0]?.id ?? '');
  const [blocks, setBlocks] = useState<MaintenanceBlock[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const selectedResource = resources.find(resource => resource.id === resourceId);
  const selectedLocation = locations.find(location => location.id === selectedResource?.locationId);
  const listedResources = resources.filter(resource => resource.status !== 'retired');

  useEffect(() => {
    if (!listedResources.some(resource => resource.id === resourceId)) setResourceId(listedResources[0]?.id ?? '');
  }, [listedResources, resourceId]);

  async function loadBlocks() {
    if (!resourceId) { setBlocks([]); return; }
    setLoading(true); setError('');
    try { setBlocks((await listBlocks(resourceId)).blocks); }
    catch (cause) { setError(friendlyError(cause, 'Could not load maintenance windows.')); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadBlocks(); }, [resourceId]);

  async function addBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    if (!selectedLocation || !start || !end) { setError('Choose a start and end time.'); setBusy(false); return; }
    try {
      const [startDay, startTime] = start.split('T');
      const [endDay, endTime] = end.split('T');
      await createBlock(resourceId, wallTimeToIso(startDay, startTime, selectedLocation.timezone), wallTimeToIso(endDay, endTime, selectedLocation.timezone), reason.trim() || undefined);
      setStart(''); setEnd(''); setReason(''); await loadBlocks(); notify('Maintenance block added.');
    } catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  async function removeBlock(id: string) {
    setBusy(true); setError('');
    try { await deleteBlock(id); setConfirmDelete(null); await loadBlocks(); notify('Maintenance block removed.'); }
    catch (cause) { const message = friendlyError(cause); setError(message); notify(message, 'error'); }
    finally { setBusy(false); }
  }

  return <div className="setup-section">
    <div className="setup-section-head"><div><p className="eyebrow">RESOURCE CARE / AVAILABILITY</p><h2>Maintenance</h2><p className="muted">Upcoming blocks make a resource unavailable for new bookings.</p></div><label className="compact-field"><span>Resource</span><select value={resourceId} onChange={event => setResourceId(event.target.value)}><option value="">{listedResources.length ? 'Choose a resource' : 'No active resources'}</option>{listedResources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label></div>
    {error && <InlineError message={error} onRetry={() => void loadBlocks()} />}
    {loading ? <Loading label="Loading maintenance" /> : blocks.length === 0 ? <EmptyState title="No upcoming blocks" detail={selectedResource ? `${selectedResource.name} has no upcoming maintenance windows.` : 'Choose a resource to view maintenance windows.'} /> : <div className="block-list">
      {blocks.map(block => <article className="block-row" key={block.id}>
        <div className="block-date"><span>WINDOW</span><b>{formatDateTime(block.start, selectedLocation?.timezone ?? 'UTC', { weekday: 'short', year: 'numeric' })}</b><small>{formatDateTime(block.start, selectedLocation?.timezone ?? 'UTC')} — {formatDateTime(block.end, selectedLocation?.timezone ?? 'UTC')}</small></div>
        <div className="block-reason"><span>REASON</span><b>{block.reason || 'Not specified'}</b></div>
        {manager && <div className="block-actions">{confirmDelete === block.id ? <><button className="text-button danger-text" onClick={() => void removeBlock(block.id)} disabled={busy}>Confirm remove</button><button className="text-button" onClick={() => setConfirmDelete(null)}>Keep</button></> : <button className="text-button danger-text" onClick={() => setConfirmDelete(block.id)}>Remove block</button>}</div>}
      </article>)}
    </div>}
    {manager ? <form className="setup-form-card" onSubmit={addBlock}>
      <div className="setup-form-heading"><span className="section-index">BLOCK TIME</span><span>15-minute boundaries · future only · {selectedLocation?.timezone ?? 'location timezone'}</span></div>
      <div className="setup-form-grid"><label className="field-label">Starts<input type="datetime-local" step="900" required value={start} onChange={event => setStart(event.target.value)} /></label><label className="field-label">Ends<input type="datetime-local" step="900" required value={end} onChange={event => setEnd(event.target.value)} /></label><label className="field-label field-span-two">Reason <span className="optional-label">OPTIONAL</span><input maxLength={200} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. Projector maintenance" /></label></div>
      <button className="button button-primary" type="submit" disabled={busy || !resourceId}>{busy ? 'Saving…' : 'Add maintenance block'}<span aria-hidden="true">↗</span></button>
      <p className="small-note">The server refuses blocks that overlap a booking or another block. Move or cancel the booking first.</p>
    </form> : <div className="permission-note">Only a location manager or organisation admin can create or remove maintenance blocks.</div>}
  </div>;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase();
}

function roleLabel(role: Role): string {
  return ({ member: 'Front desk', location_manager: 'Location manager', org_admin: 'Organisation admin' })[role];
}
