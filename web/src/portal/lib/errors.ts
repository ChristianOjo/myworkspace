import { ApiError } from '../api/client';

const reasonMessages: Record<string, string> = {
  invalid_credentials: "We couldn't sign you in. Check your email and password.",
  invalid_email: 'Enter a valid email address.',
  invalid_name: 'Enter your full name.',
  invalid_phone: 'Enter a valid contact number.',
  invalid_org_slug: 'Enter the organisation slug provided by your workspace.',
  unknown_org: 'We could not find that organisation. Check the slug and try again.',
  unknown_org_login: 'We could not find that organisation. Check the slug and try again.',
  multiple_orgs: 'This portal serves several workspaces. Enter the slug for yours.',
  invalid_password: 'Use a password with at least 10 characters.',
  weak_password: 'Use a password with at least 10 characters.',
  email_taken: 'An account already uses this email. Sign in instead.',
  wrong_current_password: 'Your current password is incorrect.',
  slot_taken: 'That slot was just taken. Choose another time.',
  slot_conflict: 'That slot was just taken. Choose another time.',
  outside_hours: 'That time is outside this location’s opening hours.',
  maintenance_block: 'That time overlaps a maintenance block. Choose another time.',
  resource_unavailable: 'This space is not available right now.',
  day_booking_not_offered: 'Whole-day booking is not offered for this space.',
  in_the_past: 'That time has passed. Pick today or a later date.',
  invalid_time: 'Choose a valid start and end time.',
  invalid_range: 'The end time must be after the start time.',
  not_on_slot_boundary: 'Choose times on a 15-minute boundary.',
  invalid_kind: 'Choose an hourly or whole-day booking.',
  invalid_id: 'The selected space could not be identified. Refresh and try again.',
  booking_not_found: 'That booking could not be found.',
  not_confirmed: 'Only a confirmed booking can be cancelled.',
  already_started: 'This booking has already started. Contact the front desk for help.',
  paid_booking_cancel: 'Paid bookings are cancelled by the front desk. Contact us for assistance.',
  staff_only: 'This area is for staff accounts.',
  customer_portal_only: 'This area is for customer accounts.',
  customer_required: 'This action needs a customer account.',
  unknown_actor: 'Your account could not be verified. Sign in again.',
  actor_inactive: 'Your account is no longer active. Contact the front desk.',
};

export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof ApiError) {
    if (error.reason && reasonMessages[error.reason]) return reasonMessages[error.reason];
    if (error.status === 429) {
      const seconds = error.retryAfter;
      return seconds ? `Too many attempts. Try again in ${seconds} seconds.` : 'Too many attempts. Wait a moment before trying again.';
    }
    if (error.status === 401) return 'Your session ended. Sign in again to continue.';
    if (error.status === 403) return 'You do not have access to that action.';
    if (error.status === 404) return 'This record could not be found. Refresh and try again.';
    if (error.status >= 500) return 'The service is having a problem. Please try again shortly.';
    if (error.status === 400) return 'Check the information entered and try again.';
  }
  if (error instanceof Error && error.message.startsWith("Can't reach")) return error.message;
  return fallback;
}
