import { useState, type FormEvent } from 'react';
import { changePassword } from '../../api/routes';
import { Drawer } from '../../components/Drawer';
import { friendlyError } from '../../lib/errors';

export function PasswordChangeDrawer({ open, onClose, notify }: { open: boolean; onClose: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (next.length < 10) { setError('Use a new password with at least 10 characters.'); return; }
    if (next !== confirm) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      notify('Password updated. Other sessions have been signed out.');
      onClose();
    } catch (cause) {
      const message = friendlyError(cause);
      setError(message);
      notify(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return <Drawer open={open} title="Change password" onClose={onClose} width="420px">
    <div className="drawer-head"><p className="eyebrow">ACCOUNT / SECURITY</p><h2>Change password</h2><p className="muted">Other sessions will be ended after the change.</p></div>
    <form className="form-stack drawer-form" onSubmit={submit}>
      <label className="field-label">Current password<input type="password" autoComplete="current-password" required value={current} onChange={event => setCurrent(event.target.value)} /></label>
      <label className="field-label">New password<input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={event => setNext(event.target.value)} /><small className="field-hint">At least 10 characters.</small></label>
      <label className="field-label">Confirm new password<input type="password" autoComplete="new-password" required minLength={10} value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
      {error && <div className="form-alert" role="alert">{error}</div>}
      <div className="drawer-actions"><button className="button button-primary" disabled={busy} type="submit">{busy ? 'Updating…' : 'Update password'}</button><button className="button button-quiet" type="button" onClick={onClose} disabled={busy}>Cancel</button></div>
    </form>
  </Drawer>;
}
