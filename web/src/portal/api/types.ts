export type PortalRole = 'customer';
export type ResourceType = 'desk' | 'dedicated_desk' | 'meeting_room' | 'phone_booth' | 'parking';
export type PortalBookingStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'checked_in'
  | 'completed'
  | 'no_show'
  | 'cancelled';
export type Pricing = 'hourly' | 'day';

export interface ApiErrorBody {
  code: string;
  reason?: string;
  message?: string;
}

export interface PortalUser {
  id: string;
  email: string;
  fullName: string;
  role: PortalRole;
  phone: string | null;
}

export interface PublicOrg {
  id: string;
  name: string;
  slug: string;
}

export interface PortalLocation {
  id: string;
  name: string;
  timezone: string;
  openHour: string;
  closeHour: string;
}

export interface PortalResource {
  id: string;
  locationId: string;
  type: ResourceType;
  name: string;
  capacity: number;
  hourlyRateCents: number;
  dayRateCents: number;
}

export interface AvailabilityInterval {
  start: string;
  end: string;
  status: string;
}

export interface AvailabilityBlock {
  start: string;
  end: string;
  reason: string | null;
}

export interface AvailabilityResource {
  id: string;
  intervals: AvailabilityInterval[];
  blocks: AvailabilityBlock[];
}

export interface Availability {
  date: string;
  locationId: string;
  timezone: string;
  resources: AvailabilityResource[];
}

export interface MyBooking {
  id: string;
  resourceId: string;
  resourceName: string;
  type: ResourceType;
  locationId: string;
  locationName: string;
  timezone: string;
  start: string;
  end: string;
  status: PortalBookingStatus;
  pricing: Pricing;
  priceCents: number;
  customerPhone: string | null;
  checkinAt: string | null;
  createdAt: string;
  cancelable: boolean;
}

export interface RegisterPayload {
  orgSlug: string;
  fullName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface CreateMyBookingPayload {
  resourceId: string;
  kind?: 'hourly' | 'day';
  start?: string;
  end?: string;
  date?: string;
  phone?: string;
}
