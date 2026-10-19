import { ApiError } from '../api/client';

const reasonMessages: Record<string, string> = {
  invalid_credentials: "We couldn't sign you in. Check your details and try again.",
  invalid_email: 'Enter a valid email address.',
  invalid_name: 'Enter a valid name between 1 and 200 characters.',
  invalid_role: 'Choose a valid staff role.',
  weak_password: 'Use a password with at least 10 characters.',
  email_taken: 'A staff account already uses this email.',
  cannot_deactivate_self: "You can't deactivate your own account.",
  wrong_current_password: 'Your current password is incorrect.',
  invalid_timezone: 'Choose a valid IANA timezone, such as Europe/London.',
  invalid_hours: 'Opening and closing times must be valid quarter-hour times, with opening before closing.',
  invalid_type: 'Choose a valid resource type.',
  invalid_capacity: 'Capacity must be from 1 to 1,000.',
  invalid_rate: 'Enter a valid rate in cents.',
  invalid_status: 'Choose a valid resource status.',
  invalid_amount: 'Enter an amount greater than zero.',
  overpayment: 'That amount is more than the balance due.',
  refund_exceeds_paid: 'The refund cannot be more than the net amount paid.',
  slot_taken: 'That slot was just taken. The schedule has been refreshed.',
  outside_hours: 'That time is outside this location’s opening hours.',
  maintenance_block: 'That time overlaps a maintenance block.',
  resource_unavailable: 'This resource is not available for booking.',
  day_booking_not_offered: 'A day booking is not offered for this resource.',
  in_the_past: 'That time has passed. Choose the current slot or a later one.',
  arrived_before_start: 'A walk-in can only be marked here once the booking has started.',
  outside_checkin_window: 'Arrival can be marked from 15 minutes before the booking starts until it ends.',
  booking_ended: 'This booking has already ended.',
  not_confirmed: 'Only a confirmed booking can be marked as arrived.',
  not_checked_in: 'Only a checked-in booking can be released early.',
  use_release: 'The customer has arrived. Use “Release early” instead of cancelling.',
  manager_required: 'This action needs a location manager.',
  admin_required: 'This action needs an organisation admin.',
  overlaps_bookings: 'This maintenance window overlaps a booking. Move or cancel that booking first.',
  overlapping_block: 'Another maintenance block already covers part of this time.',
  booking_not_payable: 'This booking can’t accept a payment in its current state.',
  invalid_state: 'This booking has changed and can’t take that action now. Refresh it and try again.',
  slot_conflict: 'That slot was just taken. The schedule has been refreshed.',
  invalid_time: 'Enter a valid date and time.',
  invalid_range: 'The end time must be after the start time.',
  not_on_slot_boundary: 'Choose times on a 15-minute boundary.',
  invalid_customer: 'Check the customer name and phone number.',
  invalid_id: 'A selected record could not be identified. Refresh and choose it again.',
  invalid_kind: 'Choose hourly or whole-day booking.',
  nothing_to_update: 'Change at least one field before saving.',
  invalid_reason: 'The reason must be between 1 and 500 characters.',
  unknown_actor: 'Your account can’t perform this action. Sign in again or ask an admin.',
  actor_inactive: 'Your account is no longer active. Ask an admin for help.',
  resource_not_found: 'This resource could not be found. Refresh and try again.',
};

export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof ApiError) {
    if (error.reason && reasonMessages[error.reason]) return reasonMessages[error.reason];
    if (error.status === 429) {
      const seconds = error.retryAfter;
      return seconds ? `Too many attempts. Try again in ${seconds} seconds.` : 'Too many attempts. Wait a moment before trying again.';
    }
    if (error.status === 401) return "We couldn't sign you in. Check your details and try again.";
    if (error.status === 403) return 'Your role does not have access to this action.';
    if (error.status === 404) return 'This record could not be found. Refresh and try again.';
    if (error.status >= 500) return 'The service is having a problem. Please try again shortly.';
    if (error.status === 400) return 'Check the information entered and try again.';
  }
  if (error instanceof Error && error.message.startsWith("Can't reach")) return error.message;
  return fallback;
}
