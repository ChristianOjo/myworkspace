import { useEffect, useState } from 'react';
import type { CashDaily, Location } from '../../api/types';
import { dailyCash } from '../../api/routes';
import { EmptyState, InlineError, Loading } from '../../components/Feedback';
import { friendlyError } from '../../lib/errors';
import { addDays, dateInZone, formatDate, money } from '../../lib/format';

export function CashView({ locations, location, date, role, currency, onLocationChange, onDateChange }: {
  locations: Location[];
  location?: Location;
  date: string;
  role: string;
  currency: string;
  onLocationChange: (id: string) => void;
  onDateChange: (date: string) => void;
}) {
  const [report, setReport] = useState<CashDaily | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!location) return;
    let current = true;
    setReport(null);
    setLoading(true);
    setError('');
    dailyCash(location.id, date).then(result => { if (current) setReport(result); })
      .catch(cause => { if (current) setError(friendlyError(cause, 'Could not load the cash report.')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [location, date, reload]);

  if (!location) return <section className="page-body"><EmptyState title="No location available" detail="Add a location before viewing cash reports." /></section>;
  const manager = role === 'location_manager' || role === 'org_admin';
  const today = dateInZone(new Date(), location.timezone);
  const heading = manager ? 'Cash report' : 'Your takings';

  return <section className="page-body cash-page">
    <div className="page-heading">
      <div><p className="eyebrow">CASH / DAILY CLOSE</p><h1>{heading}</h1><p className="heading-note">{manager ? 'Payments and refunds recorded at this location.' : 'Only payments and refunds recorded by you are shown.'}</p></div>
      <div className="heading-actions">
        <label className="compact-field"><span>Location</span><select value={location.id} onChange={event => onLocationChange(event.target.value)} aria-label="Cash report location">{locations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="compact-field"><span>Date</span><input type="date" value={date} onChange={event => onDateChange(event.target.value)} aria-label="Cash report date" /></label>
        <div className="date-stepper"><button className="icon-button" title="Previous day" aria-label="Previous day" onClick={() => onDateChange(addDays(date, -1))}>←</button><button className="icon-button" title="Next day" aria-label="Next day" onClick={() => onDateChange(addDays(date, 1))} disabled={date >= today}>→</button></div>
        <button className="button button-quiet refresh-button" onClick={() => setReload(value => value + 1)} disabled={loading} aria-label="Refresh cash report">↻</button>
      </div>
    </div>
    <div className="report-date-line"><span>{formatDate(date, { year: 'numeric' })}</span><span>{location.timezone}</span></div>
    {error && <InlineError message={error} onRetry={() => setReload(value => value + 1)} />}
    {loading && !report ? <Loading label="Loading cash report" /> : report && <>
      <div className="summary-grid">
        <Summary label="PAYMENTS" value={money(report.totals.paymentsCents, currency)} detail={`${report.totals.paymentCount} transaction${report.totals.paymentCount === 1 ? '' : 's'}`} />
        <Summary label="REFUNDS" value={money(report.totals.refundsCents, currency)} detail={`${report.totals.refundCount} transaction${report.totals.refundCount === 1 ? '' : 's'}`} />
        <Summary label="NET CASH" value={money(report.totals.netCents, currency)} detail="Payments less refunds" emphasis />
      </div>
      {report.staff.length === 0 ? <EmptyState title="No cash recorded" detail={date === today ? 'Payments you record on a booking will appear here.' : 'There are no payments for this day.'} /> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>{manager ? 'STAFF MEMBER' : 'YOUR TAKINGS'}</th><th>PAYMENTS</th><th>REFUNDS</th><th>NET</th><th>COUNT</th></tr></thead>
          <tbody>{report.staff.map(row => <tr key={row.userId}>
            <td><b>{row.fullName}</b></td><td>{money(row.paymentsCents, currency)}</td><td>{money(row.refundsCents, currency)}</td><td className="table-emphasis">{money(row.netCents, currency)}</td><td className="table-count">{row.paymentCount} / {row.refundCount}</td>
          </tr>)}</tbody>
          {manager && <tfoot><tr><td>TOTAL</td><td>{money(report.totals.paymentsCents, currency)}</td><td>{money(report.totals.refundsCents, currency)}</td><td>{money(report.totals.netCents, currency)}</td><td>{report.totals.paymentCount} / {report.totals.refundCount}</td></tr></tfoot>}
        </table></div>}
      <p className="table-caption"><span>Amounts in {currency}; counts are payments / refunds.</span><span>Report day follows the location timezone.</span></p>
    </>}
  </section>;
}

function Summary({ label, value, detail, emphasis = false }: { label: string; value: string; detail: string; emphasis?: boolean }) {
  return <article className={`summary-card ${emphasis ? 'summary-emphasis' : ''}`}><span className="section-index">{label}</span><b>{value}</b><small>{detail}</small></article>;
}
