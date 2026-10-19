import type { BookingStatus, PaymentStatus, ResourceStatus } from '../api/types';
import { statusLabel } from '../lib/format';

type Status = BookingStatus | PaymentStatus | ResourceStatus;

const labels: Record<Status, string> = {
  confirmed: 'Booked', checked_in: 'Here now', completed: 'Finished', no_show: 'No-show', cancelled: 'Cancelled',
  unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid', void: 'Void',
  active: 'Active', maintenance: 'Maintenance', retired: 'Retired',
};

export function StatusBadge({ status }: { status: Status }) {
  const label = status === 'confirmed' || status === 'checked_in' || status === 'completed' || status === 'no_show' || status === 'cancelled'
    ? statusLabel(status as BookingStatus)
    : labels[status];
  return <span className={`status-badge status-${status}`}><span className="status-dot" aria-hidden="true" />{label}</span>;
}
