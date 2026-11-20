import { api } from './client';
import type {
  Availability,
  CreateMyBookingPayload,
  MyBooking,
  PortalLocation,
  PortalResource,
  PortalUser,
  PublicOrg,
  RegisterPayload,
} from './types';

export interface AuthResponse {
  token: string;
  expiresAt: string;
  user: PortalUser;
}

export interface MeResponse {
  user: PortalUser;
  session: { expiresAt: string };
}

// Account
export function register(payload: RegisterPayload) {
  return api.post<AuthResponse>('/auth/register', payload);
}

export function login(orgSlug: string, email: string, password: string) {
  return api.post<AuthResponse>('/auth/login', { orgSlug, email, password });
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

// Public catalogue (no token required)
export function publicOrg(slug: string) {
  return api.get<{ org: PublicOrg }>(`/public/${encodeURIComponent(slug)}/org`);
}

export function publicLocations(slug: string) {
  return api.get<{ locations: PortalLocation[] }>(`/public/${encodeURIComponent(slug)}/locations`);
}

export function publicResources(slug: string, locationId?: string) {
  const query = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  return api.get<{ resources: PortalResource[] }>(`/public/${encodeURIComponent(slug)}/resources${query}`);
}

export function publicAvailability(slug: string, locationId: string, date: string) {
  const query = new URLSearchParams({ locationId, date });
  return api.get<{ availability: Availability }>(`/public/${encodeURIComponent(slug)}/availability?${query}`);
}

// My bookings (customer role only)
export function listMyBookings() {
  return api.get<{ bookings: MyBooking[] }>('/me/bookings');
}

export function getMyBooking(id: string) {
  return api.get<{ booking: MyBooking }>(`/me/bookings/${encodeURIComponent(id)}`);
}

export function createMyBooking(payload: CreateMyBookingPayload) {
  return api.post<{ booking: MyBooking }>('/me/bookings', payload);
}

export function cancelMyBooking(id: string, reason?: string) {
  return api.post<{ booking: Pick<MyBooking, 'id' | 'status'> }>(
    `/me/bookings/${encodeURIComponent(id)}/cancel`,
    reason ? { reason } : {}
  );
}
