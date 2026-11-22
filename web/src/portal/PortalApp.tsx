import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Availability,
  CreateMyBookingPayload,
  MyBooking,
  PortalLocation,
  PortalResource,
  PortalUser,
} from './api/types';
import { clearToken, getToken, setToken } from './api/client';
import {
  cancelMyBooking,
  createMyBooking,
  listMyBookings,
  logout,
  me,
  publicAvailability,
  publicLocations,
  publicOrg,
  publicResources,
} from './api/routes';
import { Loading } from '../components/Feedback';
import { AuthScreen } from './features/AuthScreen';
import { BrowseView } from './features/BrowseView';
import { BookingDrawer } from './features/BookingDrawer';
import { BookingsView } from './features/BookingsView';
import { PasswordDrawer } from './features/PasswordDrawer';
import { friendlyError } from './lib/errors';
import { dateInZone } from '../lib/format';

type Tab = 'browse' | 'bookings';
type Notice = { text: string; kind: 'success' | 'error' } | null;

const SLUG_KEY = 'myworkspace.portal.slug';
const CURRENCY_KEY = 'myworkspace.portal.currency';
const QUERY_TAB = 'tab';
const QUERY_DATE = 'date';
const QUERY_LOCATION = 'loc';

function readPortalQuery(): { tab: Tab; date: string; locationId: string } {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get(QUERY_TAB) === 'bookings' ? 'bookings' : 'browse';
  const rawDate = params.get(QUERY_DATE) ?? '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '';
  const locationId = params.get(QUERY_LOCATION) ?? '';
  return { tab, date, locationId };
}

export function PortalApp() {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [slug, setSlug] = useState('');
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>(() => readPortalQuery().tab);
  const [orgName, setOrgName] = useState('');
  const [locations, setLocations] = useState<PortalLocation[]>([]);
  const [locationId, setLocationId] = useState(() => readPortalQuery().locationId);
  const [date, setDate] = useState(() => readPortalQuery().date || dateInZone());
  const [resources, setResources] = useState<PortalResource[]>([]);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsError, setBookingsError] = useState('');
  const [busyBookingId, setBusyBookingId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<PortalResource | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const refreshSeq = useRef(0);

  const location = useMemo(() => locations.find(item => item.id === locationId) ?? null, [locations, locationId]);
  const currency = useMemo(() => localStorage.getItem(CURRENCY_KEY) ?? '', []);

  const notify = useCallback((text: string, kind: 'success' | 'error' = 'success') => setNotice({ text, kind }), []);

  useEffect(() => {
    const timer = notice ? window.setTimeout(() => setNotice(null), 3800) : undefined;
    return () => { if (timer) window.clearTimeout(timer); };
  }, [notice]);

  useEffect(() => {
    let active = true;
    const unauthorized = () => {
      clearToken();
      setUser(null);
      setSessionEnded(true);
      setTab('browse');
    };
    window.addEventListener('myworkspace-portal:unauthorized', unauthorized);
    const token = getToken();
    const storedSlug = sessionStorage.getItem(SLUG_KEY) ?? '';
    if (!token || !storedSlug) {
      setBooting(false);
      return () => { active = false; window.removeEventListener('myworkspace-portal:unauthorized', unauthorized); };
    }
    setSlug(storedSlug);
    me().then(result => {
      if (active) setUser(result.user);
    }).catch(() => {
      if (active) { clearToken(); sessionStorage.removeItem(SLUG_KEY); setSessionEnded(true); }
    }).finally(() => { if (active) setBooting(false); });
    return () => { active = false; window.removeEventListener('myworkspace-portal:unauthorized', unauthorized); };
  }, []);

  const loadCatalog = useCallback(async (orgSlug: string, locId: string, day: string) => {
    if (!orgSlug || !locId) return;
    const seq = ++refreshSeq.current;
    setBrowseLoading(true);
    setBrowseError('');
    try {
      const [resourceResponse, availabilityResponse] = await Promise.all([
        publicResources(orgSlug, locId),
        publicAvailability(orgSlug, locId, day),
      ]);
      if (seq !== refreshSeq.current) return;
      setResources(resourceResponse.resources);
      setAvailability(availabilityResponse.availability);
    } catch (cause) {
      if (seq !== refreshSeq.current) return;
      setBrowseError(friendlyError(cause, 'Could not load available spaces. Refresh to try again.'));
    } finally {
      if (seq === refreshSeq.current) setBrowseLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user || !slug) return;
    let active = true;
    Promise.all([publicOrg(slug), publicLocations(slug)]).then(([orgResponse, locationResponse]) => {
      if (!active) return;
      setOrgName(orgResponse.org.name);
      setLocations(locationResponse.locations);
      const firstId = locationResponse.locations[0]?.id ?? '';
      setLocationId(current => current && locationResponse.locations.some(item => item.id === current) ? current : firstId);
    }).catch(cause => { if (active) setBrowseError(friendlyError(cause, 'Could not load this organisation.')); });
    return () => { active = false; };
  }, [user, slug]);

  useEffect(() => {
    if (!user || !locationId) return;
    void loadCatalog(slug, locationId, date);
  }, [user, slug, locationId, date, loadCatalog]);

  // Keep the shareable state (tab, date, location) in the query string so a
  // refreshed or shared link restores exactly what the customer was viewing.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    params.set(QUERY_TAB, tab);
    if (tab === 'browse') {
      if (date) params.set(QUERY_DATE, date); else params.delete(QUERY_DATE);
      if (locationId) params.set(QUERY_LOCATION, locationId); else params.delete(QUERY_LOCATION);
    } else {
      params.delete(QUERY_DATE);
      params.delete(QUERY_LOCATION);
    }
    const search = `?${params.toString()}`;
    if (search !== window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}${search}`);
    }
  }, [user, tab, date, locationId]);

  const refreshBookings = useCallback(async () => {
    if (!user) return;
    setBookingsLoading(true);
    setBookingsError('');
    try {
      const response = await listMyBookings();
      setBookings(response.bookings);
    } catch (cause) {
      setBookingsError(friendlyError(cause, 'Could not load your bookings.'));
    } finally {
      setBookingsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (tab === 'bookings') void refreshBookings();
  }, [tab, refreshBookings]);

  function handleAuth(nextUser: PortalUser, orgSlug: string) {
    sessionStorage.setItem(SLUG_KEY, orgSlug);
    setSlug(orgSlug);
    setUser(nextUser);
    setSessionEnded(false);
    setTab('browse');
  }

  async function handleLogout() {
    try { await logout(); } catch { /* local sign-out still completes if the service is unavailable. */ }
    clearToken();
    sessionStorage.removeItem(SLUG_KEY);
    setUser(null);
    setLocations([]);
    setResources([]);
    setAvailability(null);
    setBookings([]);
    setSelectedResource(null);
    setTab('browse');
    setSessionEnded(false);
  }

  async function handleCreateBooking(payload: CreateMyBookingPayload) {
    await createMyBooking(payload);
    notify('Booking confirmed. Show your name at the front desk.');
    await Promise.all([
      loadCatalog(slug, locationId, date),
      tab === 'bookings' ? refreshBookings() : Promise.resolve(),
    ]);
  }

  async function handleCancel(booking: MyBooking) {
    setBusyBookingId(booking.id);
    try {
      await cancelMyBooking(booking.id);
      notify('Booking cancelled.');
      await refreshBookings();
    } catch (cause) {
      notify(friendlyError(cause, 'The booking could not be cancelled.'), 'error');
    } finally {
      setBusyBookingId(null);
    }
  }

  function changeLocation(id: string) {
    setLocationId(id);
    const next = locations.find(item => item.id === id);
    if (next) setDate(dateInZone(new Date(), next.timezone));
  }

  function initials(name: string): string {
    return name.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase();
  }

  const drawerLocation: PortalLocation = location ?? {
    id: '',
    name: '',
    timezone: 'UTC',
    openHour: '08:00',
    closeHour: '18:00',
  };

  if (booting) return <div className="boot-screen"><span className="brand-lockup"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><b>MYWORKSPACE</b><small>BOOK A SPACE</small></span></span><Loading label="Restoring your session" /></div>;

  if (!user) return <>
    {sessionEnded && <div className="session-expired-banner" role="status">Your session has ended. Sign in again to continue.</div>}
    <AuthScreen onAuth={handleAuth} />
  </>;

  return <div className="app-shell portal-shell">
    <a className="skip-link" href="#portal-main">Skip to main content</a>
    <header className="topbar">
      <a className="brand-lockup" href="/portal" aria-label="Myworkspace customer portal">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span><b>MYWORKSPACE</b><small>BOOK A SPACE</small></span>
      </a>
      <nav className="main-nav" aria-label="Customer navigation">
        <button className={tab === 'browse' ? 'nav-item is-active' : 'nav-item'} onClick={() => setTab('browse')} aria-current={tab === 'browse' ? 'page' : undefined}><span className="nav-index">01</span>Browse spaces</button>
        <button className={tab === 'bookings' ? 'nav-item is-active' : 'nav-item'} onClick={() => setTab('bookings')} aria-current={tab === 'bookings' ? 'page' : undefined}><span className="nav-index">02</span>My bookings</button>
      </nav>
      <div className="topbar-spacer" />
      {location && <span className="topbar-location"><span className="location-marker" />{location.name}</span>}
      <details className="profile-menu">
        <summary className="profile-trigger"><span className="profile-initials">{initials(user.fullName)}</span><span className="profile-copy"><b>{user.fullName}</b><small>Customer</small></span><span className="profile-chevron" aria-hidden="true">⌄</span></summary>
        <div className="profile-popover">
          <div className="profile-popover-head"><span className="section-index">ACCOUNT</span><b>{user.email}</b></div>
          {user.company && <p className="profile-popover-company muted">{user.company}</p>}
          {user.phone && <p className="profile-popover-phone muted">{user.phone}</p>}
          <button className="profile-action" onClick={() => setPasswordOpen(true)}>Change password <span aria-hidden="true">↗</span></button>
          <button className="profile-action" onClick={() => void handleLogout()}>Sign out <span aria-hidden="true">↗</span></button>
          <a className="profile-action" href="/">Staff sign in <span aria-hidden="true">↗</span></a>
        </div>
      </details>
    </header>

    <main className="app-content" id="portal-main">
      {tab === 'browse' && <BrowseView
        orgName={orgName}
        locations={locations}
        locationId={locationId}
        onLocationChange={changeLocation}
        date={date}
        onDateChange={setDate}
        resources={resources}
        availability={availability}
        loading={browseLoading}
        error={browseError}
        currency={currency}
        onBook={setSelectedResource}
      />}
      {tab === 'bookings' && <BookingsView
        bookings={bookings}
        loading={bookingsLoading}
        error={bookingsError}
        currency={currency}
        busyId={busyBookingId}
        onCancel={handleCancel}
        onRetry={refreshBookings}
      />}
    </main>

    <BookingDrawer
      open={selectedResource !== null}
      resource={selectedResource}
      location={drawerLocation}
      date={date}
      availability={availability?.resources.find(item => item.id === selectedResource?.id) ?? null}
      profileName={user.fullName}
      defaultPhone={user.phone ?? ''}
      currency={currency}
      onClose={() => setSelectedResource(null)}
      onSubmit={handleCreateBooking}
    />
    <PasswordDrawer open={passwordOpen} onClose={() => setPasswordOpen(false)} notify={notify} />
    {notice && <div className={`toast toast-${notice.kind}`} role="status" aria-live="polite"><span>{notice.kind === 'error' ? '!' : '✓'}</span>{notice.text}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}
    <footer className="app-footer"><span>MYWORKSPACE / CUSTOMER PORTAL</span><span>SELF-SERVICE BOOKING</span><span>{location?.timezone ?? 'LOCAL TIME'}</span></footer>
  </div>;
}
