import type { BookingStatus } from '../api/types';

const datePartsFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partsInZone(date: Date, timeZone: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of datePartsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

export function dateInZone(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localClock(date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const p = partsInZone(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function minuteOfDay(iso: string, timeZone: string): number {
  const p = partsInZone(new Date(iso), timeZone);
  return p.hour * 60 + p.minute;
}

export function wallTimeToIso(day: string, time: string, timeZone: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const targetUtc = Date.UTC(year, month - 1, date, hour, minute, 0);
  let guess = targetUtc;
  for (let i = 0; i < 4; i += 1) {
    const p = partsInZone(new Date(guess), timeZone);
    const representedUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const delta = targetUtc - representedUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess).toISOString();
}

export function minuteToClock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function parseClock(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function addDays(day: string, count: number): string {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function formatDate(day: string, options?: Intl.DateTimeFormatOptions): string {
  const date = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC', ...options }).format(date);
}

export function formatDateTime(iso: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone, ...options,
  }).format(new Date(iso));
}

export function money(cents: number, symbol = ''): string {
  return `${symbol}${(cents / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseMoneyToCents(value: string): number {
  const text = value.trim();
  if (text.includes('-')) return 0;
  const digits = text.replace(/[^0-9.,]/g, '');
  const sep = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  const tail = sep >= 0 ? digits.slice(sep + 1) : '';
  const decimal = sep >= 0 && tail.length >= 1 && tail.length <= 2;
  const whole = (decimal ? digits.slice(0, sep) : digits).replace(/[.,]/g, '');
  const cents = Number(whole || '0') * 100 + (decimal ? Number(tail.padEnd(2, '0')) : 0);
  return Number.isSafeInteger(cents) ? cents : 0;
}

export function roleLabel(role: string): string {
  return ({ member: 'Front desk', location_manager: 'Location manager', org_admin: 'Organisation admin' } as Record<string, string>)[role] ?? role;
}

export function statusLabel(status: BookingStatus): string {
  return ({ confirmed: 'Booked', checked_in: 'Here now', completed: 'Finished', no_show: 'No-show', cancelled: 'Cancelled' })[status];
}

export function isManager(role: string): boolean {
  return role === 'location_manager' || role === 'org_admin';
}

export function isAdmin(role: string): boolean {
  return role === 'org_admin';
}
