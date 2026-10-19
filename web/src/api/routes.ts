import { api } from './client';
import type {
  Balance,
  Booking,
  BookingDetail,
  CashDaily,
  CreateBookingPayload,
  Location,
  MaintenanceBlock,
  Payment,
  Resource,
  Role,
  StaffMember,
  User,
} from './types';

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: User;
}

export interface MeResponse {
  user: User;
  session: { expiresAt: string };
}

export function login(orgSlug: string, email: string, password: string) {
  return api.post<LoginResponse>('/auth/login', { orgSlug, email, password });
}
export function me() {
  return api.get<MeResponse>('/auth/me');
}
export function logout() {
  return api.post<void>('/auth/logout');
}
export function changePassword(currentPassword: string, newPassword: string) {
  return api.post<void>('/auth/password', { currentPassword, newPassword });
}
export function listLocations() {
  return api.get<{ locations: Location[] }>('/locations');
}
export function listResources(locationId: string, includeRetired = false) {
  const query = new URLSearchParams({ locationId });
  if (includeRetired) query.set('includeRetired', 'true');
  return api.get<{ resources: Resource[] }>(`/resources?${query}`);
}
export function listBookings(locationId: string, date: string, includeCancelled = false) {
  const query = new URLSearchParams({ locationId, date });
  if (includeCancelled) query.set('includeCancelled', 'true');
  return api.get<{ date: string; locationId: string; timezone: string; bookings: Booking[] }>(`/bookings?${query}`);
}
export function getBooking(id: string) {
  return api.get<{ booking: BookingDetail; balance: Balance; payments: Payment[] }>(`/bookings/${encodeURIComponent(id)}`);
}
export function createBooking(payload: CreateBookingPayload) {
  return api.post<{ booking: BookingDetail }>('/bookings', payload);
}
export function markArrived(id: string) {
  return api.post<{ booking: Pick<BookingDetail, 'id' | 'status' | 'checkinAt'> }>(`/bookings/${encodeURIComponent(id)}/arrived`);
}
export function cancelBooking(id: string, body: { reason?: string; refundCents?: number } = {}) {
  return api.post<{ booking: Pick<BookingDetail, 'id' | 'status'>; refund: { paymentId: string; amountCents: number } | null }>(`/bookings/${encodeURIComponent(id)}/cancel`, body);
}
export function releaseBooking(id: string) {
  return api.post<{ booking: { id: string; status: BookingDetail['status']; end: string; releasedBeforeStart: boolean } }>(`/bookings/${encodeURIComponent(id)}/release`);
}
export function takePayment(id: string, amountCents: number, note?: string) {
  return api.post<{ payment: Payment; balance: Balance }>(`/bookings/${encodeURIComponent(id)}/payments`, { amountCents, ...(note ? { note } : {}) });
}
export function refundPayment(id: string, amountCents: number, note?: string) {
  return api.post<{ payment: Payment; balance: Balance }>(`/bookings/${encodeURIComponent(id)}/refunds`, { amountCents, ...(note ? { note } : {}) });
}
export function dailyCash(locationId: string, date: string) {
  const query = new URLSearchParams({ locationId, date });
  return api.get<CashDaily>(`/cash/daily?${query}`);
}
export function listStaff() {
  return api.get<{ staff: StaffMember[] }>('/staff');
}
export function createStaff(email: string, fullName: string, role: Role, password: string) {
  return api.post<{ user: StaffMember }>('/staff', { email, fullName, role, password });
}
export function deactivateStaff(id: string) {
  return api.post<{ ok: true }>(`/staff/${encodeURIComponent(id)}/deactivate`);
}
export function resetStaffPassword(id: string, newPassword: string) {
  return api.post<void>(`/staff/${encodeURIComponent(id)}/password`, { newPassword });
}
export function createLocation(payload: Pick<Location, 'name' | 'timezone' | 'openHour' | 'closeHour'>) {
  return api.post<{ location: Location }>('/locations', payload);
}
export function updateLocation(id: string, payload: Partial<Pick<Location, 'name' | 'timezone' | 'openHour' | 'closeHour'>>) {
  return api.patch<{ location: Location }>(`/locations/${encodeURIComponent(id)}`, payload);
}
export function createResource(payload: Omit<Resource, 'id'>) {
  return api.post<{ resource: Resource }>('/resources', payload);
}
export function updateResource(id: string, payload: Partial<Pick<Resource, 'name' | 'capacity' | 'hourlyRateCents' | 'dayRateCents' | 'status'>>) {
  return api.patch<{ resource: Resource; activeFutureBookings?: number }>(`/resources/${encodeURIComponent(id)}`, payload);
}
export function listBlocks(resourceId: string) {
  return api.get<{ blocks: MaintenanceBlock[] }>(`/resources/${encodeURIComponent(resourceId)}/blocks`);
}
export function createBlock(resourceId: string, start: string, end: string, reason?: string) {
  return api.post<{ block: MaintenanceBlock }>(`/resources/${encodeURIComponent(resourceId)}/blocks`, { start, end, ...(reason ? { reason } : {}) });
}
export function deleteBlock(id: string) {
  return api.delete<void>(`/blocks/${encodeURIComponent(id)}`);
}
