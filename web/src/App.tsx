import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Booking, CreateBookingPayload, Location, Resource, User } from './api/types';
import { ApiError, clearToken, getToken, setToken } from './api/client';
import { createBooking, listBookings, listLocations, listResources, login as loginApi, logout as logoutApi, me } from './api/routes';
import { Brand } from './components/Brand';
import { Loading } from './components/Feedback';
import { LoginScreen } from './features/auth/LoginScreen';
import { PasswordChangeDrawer } from './features/auth/PasswordChangeDrawer';
import { BookingDetails } from './features/bookings/BookingDetails';
import { CalendarView } from './features/calendar/CalendarView';
import { CashView } from './features/cash/CashView';
import { SetupView } from './features/setup/SetupView';
import { friendlyError } from './lib/errors';
import { dateInZone, isManager, roleLabel } from './lib/format';
import { getCurrencySymbol, saveCurrencySymbol } from './lib/preferences';

 type Page = 'calendar' | 'cash' | 'setup';
 type Notice = { text: string; kind: 'success' | 'error' } | null;

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState<Page>('calendar');
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState('');
  const location = useMemo(() => locations.find(item => item.id === locationId), [locations, locationId]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [calendarDate, setCalendarDate] = useState(dateInZone());
  const [cashDate, setCashDate] = useState(dateInZone());
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState('');
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currency, setCurrency] = useState(getCurrencySymbol);
  const [notice, setNotice] = useState<Notice>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [locationReload, setLocationReload] = useState(0);
  const refreshSeq = useRef(0);
  const locationResources = useMemo(() => resources.filter(item => item.locationId === locationId), [resources, locationId]);

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
      setPage('calendar');
    };
    window.addEventListener('myworkspace:unauthorized', unauthorized);
    if (!getToken()) {
      setBooting(false);
    } else {
      me().then(result => { if (active) setUser(result.user); })
        .catch(() => { if (active) { clearToken(); setSessionEnded(true); } })
        .finally(() => { if (active) setBooting(false); });
    }
    return () => { active = false; window.removeEventListener('myworkspace:unauthorized', unauthorized); };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    listLocations().then(result => {
      if (!active) return;
      setLocations(result.locations);
      setLocationId(current => result.locations.some(item => item.id === current) ? current : result.locations[0]?.id ?? '');
    }).catch(cause => { if (active) notify(friendlyError(cause, 'Could not load locations.'), 'error'); });
    return () => { active = false; };
  }, [user, locationReload, notify]);

  useEffect(() => {
    if (!location) return;
    setResources([]);
    setBookings([]);
    setCalendarDate(dateInZone(new Date(), location.timezone));
    setCashDate(dateInZone(new Date(), location.timezone));
  }, [location?.id]);

  const refreshCalendar = useCallback(async () => {
    if (!location) return;
    const seq = ++refreshSeq.current;
    setCalendarLoading(true);
    setCalendarError('');
    try {
      const [resourceResponse, bookingResponse] = await Promise.all([
        listResources(location.id, isManager(user?.role ?? '')),
        listBookings(location.id, calendarDate),
      ]);
      if (seq !== refreshSeq.current) return;
      setResources(resourceResponse.resources);
      setBookings(bookingResponse.bookings);
    } catch (cause) {
      if (seq !== refreshSeq.current) return;
      setCalendarError(friendlyError(cause, 'Could not load the schedule.'));
    } finally {
      if (seq === refreshSeq.current) setCalendarLoading(false);
    }
  }, [location, calendarDate, user?.role]);

  useEffect(() => {
    if (!user || !location) return;
    void refreshCalendar();
    const interval = window.setInterval(() => void refreshCalendar(), 45_000);
    const onFocus = () => void refreshCalendar();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [user, location, refreshCalendar]);

  async function handleLogin(orgSlug: string, email: string, password: string) {
    const result = await loginApi(orgSlug, email, password);
    setToken(result.token);
    try {
      const identity = await me();
      setUser(identity.user);
      setSessionEnded(false);
      setPage('calendar');
    } catch (cause) {
      clearToken();
      throw cause;
    }
  }

  async function handleLogout() {
    try { await logoutApi(); } catch { /* A local sign-out still completes if the service is unavailable. */ }
    clearToken();
    setUser(null);
    setLocations([]);
    setResources([]);
    setBookings([]);
    setSelectedBookingId(null);
    setPage('calendar');
    setSessionEnded(false);
  }

  async function handleCreateBooking(payload: CreateBookingPayload) {
    try {
      await createBooking(payload);
    } catch (cause) {
      if (cause instanceof ApiError && ['slot_taken', 'slot_conflict'].includes(cause.reason ?? '')) await refreshCalendar();
      throw cause;
    }
    notify('Booking confirmed.');
    await refreshCalendar();
  }

  function changeLocation(id: string) {
    setLocationId(id);
    const next = locations.find(item => item.id === id);
    if (next) {
      setCalendarDate(dateInZone(new Date(), next.timezone));
      setCashDate(dateInZone(new Date(), next.timezone));
    }
  }

  function changeCurrency(value: string) {
    const normalized = value.slice(0, 4);
    setCurrency(normalized);
    saveCurrencySymbol(normalized);
  }

  if (booting) return <div className="boot-screen"><Brand /><Loading label="Restoring secure session" /></div>;
  if (!user) return <>
    {sessionEnded && <div className="session-expired-banner" role="status">Your session has ended. Sign in again to continue.</div>}
    <LoginScreen onLogin={handleLogin} />
  </>;

  return <div className="app-shell">
    <header className="topbar">
      <Brand compact />
      <nav className="main-nav" aria-label="Main navigation">
        <button className={page === 'calendar' ? 'nav-item is-active' : 'nav-item'} onClick={() => setPage('calendar')} aria-current={page === 'calendar' ? 'page' : undefined}><span className="nav-index">01</span>Calendar</button>
        <button className={page === 'cash' ? 'nav-item is-active' : 'nav-item'} onClick={() => setPage('cash')} aria-current={page === 'cash' ? 'page' : undefined}><span className="nav-index">02</span>Cash</button>
        {isManager(user.role) && <button className={page === 'setup' ? 'nav-item is-active' : 'nav-item'} onClick={() => setPage('setup')} aria-current={page === 'setup' ? 'page' : undefined}><span className="nav-index">03</span>Setup</button>}
      </nav>
      <div className="topbar-spacer" />
      {location && <span className="topbar-location"><span className="location-marker" />{location.name}</span>}
      <details className="profile-menu">
        <summary className="profile-trigger"><span className="profile-initials">{initials(user.fullName)}</span><span className="profile-copy"><b>{user.fullName}</b><small>{roleLabel(user.role)}</small></span><span className="profile-chevron">⌄</span></summary>
        <div className="profile-popover">
          <div className="profile-popover-head"><span className="section-index">ACCOUNT</span><b>{user.email}</b></div>
          <label className="field-label currency-setting">Currency symbol <span className="optional-label">THIS BROWSER</span><input maxLength={4} value={currency} onChange={event => changeCurrency(event.target.value)} aria-label="Currency symbol" /></label>
          <p className="currency-note">The API has no shared currency setting, so this preference stays on this device.</p>
          <button className="profile-action" onClick={() => setPasswordOpen(true)}>Change password <span>↗</span></button>
          <button className="profile-action profile-signout" onClick={() => void handleLogout()}>Sign out <span>↗</span></button>
        </div>
      </details>
    </header>

    <main className="app-content">
      {page === 'calendar' && <CalendarView location={location} locations={locations} date={calendarDate} resources={locationResources} bookings={bookings} role={user.role} loading={calendarLoading} error={calendarError} onDateChange={setCalendarDate} onLocationChange={changeLocation} onRefresh={() => void refreshCalendar()} onCreate={handleCreateBooking} onSelectBooking={setSelectedBookingId} currency={currency} />}
      {page === 'cash' && <CashView locations={locations} location={location} date={cashDate} role={user.role} currency={currency} onLocationChange={changeLocation} onDateChange={setCashDate} />}
      {page === 'setup' && isManager(user.role) && <SetupView role={user.role} user={user} locations={locations} resources={locationResources} currency={currency} onLocationsChanged={() => setLocationReload(value => value + 1)} onResourcesChanged={() => void refreshCalendar()} notify={notify} />}
      {page === 'setup' && !isManager(user.role) && <div className="page-body"><p className="form-alert">Your role does not have access to Setup.</p></div>}
    </main>

    <BookingDetails id={selectedBookingId} location={location} role={user.role} currency={currency} onClose={() => setSelectedBookingId(null)} onUpdated={() => void refreshCalendar()} notify={notify} />
    <PasswordChangeDrawer open={passwordOpen} onClose={() => setPasswordOpen(false)} notify={notify} />
    {notice && <div className={`toast toast-${notice.kind}`} role="status" aria-live="polite"><span>{notice.kind === 'error' ? '!' : '✓'}</span>{notice.text}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}
    <footer className="app-footer"><span>MYWORKSPACE / FRONT DESK</span><span>STAFF OPERATIONS</span><span>{location?.timezone ?? 'LOCAL TIME'}</span></footer>
  </div>;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase();
}
