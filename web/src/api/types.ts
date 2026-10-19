export type Role = 'member' | 'location_manager' | 'org_admin';
export type ResourceType = 'desk' | 'dedicated_desk' | 'meeting_room' | 'phone_booth' | 'parking';
export type ResourceStatus = 'active' | 'maintenance' | 'retired';
export type BookingStatus = 'confirmed' | 'checked_in' | 'completed' | 'no_show' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'partial' | 'paid' | 'void';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

export interface Location {
  id: string;
  name: string;
  timezone: string;
  openHour: string;
  closeHour: string;
}

export interface Resource {
  id: string;
  locationId: string;
  type: ResourceType;
  name: string;
  capacity?: number | null;
  status: ResourceStatus;
  hourlyRateCents: number;
  dayRateCents: number;
}

export interface Booking {
  id: string;
  resourceId: string;
  resourceName: string;
  start: string;
  end: string;
  status: BookingStatus;
  customerName: string;
  customerPhone: string | null;
  priceCents: number;
  pricing: 'hourly' | 'day';
  netPaidCents: number;
  paymentStatus: PaymentStatus;
  checkinAt: string | null;
  createdByName: string;
}

export interface BookingDetail {
  id: string;
  resourceId: string;
  resourceName: string;
  locationId: string;
  start: string;
  end: string;
  status: BookingStatus;
  customerName: string;
  customerPhone: string | null;
  priceCents: number;
  pricing: 'hourly' | 'day';
  checkinAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  createdByName: string;
}

export interface Balance {
  priceCents: number;
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  dueCents: number;
  paymentStatus: PaymentStatus;
}

export interface Payment {
  id: string;
  kind: 'payment' | 'refund';
  amountCents: number;
  receivedByName: string;
  note: string | null;
  createdAt: string;
}

export interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  deactivatedAt: string | null;
  createdAt: string;
}

export interface MaintenanceBlock {
  id: string;
  resourceId: string;
  start: string;
  end: string;
  reason: string | null;
  createdAt: string;
}

export interface CashStaffRow {
  userId: string;
  fullName: string;
  paymentsCents: number;
  refundsCents: number;
  netCents: number;
  paymentCount: number;
  refundCount: number;
}

export interface CashTotals {
  paymentsCents: number;
  refundsCents: number;
  netCents: number;
  paymentCount: number;
  refundCount: number;
}

export interface CashDaily {
  date: string;
  locationId: string;
  timezone: string;
  staff: CashStaffRow[];
  totals: CashTotals;
}

export interface ApiErrorBody {
  code: string;
  reason?: string;
  message?: string;
}

export interface CreateBookingPayload {
  resourceId: string;
  start?: string;
  end?: string;
  kind?: 'day';
  date?: string;
  customerName: string;
  customerPhone?: string;
  arrivedNow?: true;
}
