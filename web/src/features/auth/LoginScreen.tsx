import { useState, type FormEvent } from 'react';
import { friendlyError } from '../../lib/errors';

export function LoginScreen({ onLogin }: { onLogin: (orgSlug: string, email: string, password: string) => Promise<void> }) {
  const [orgSlug, setOrgSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onLogin(orgSlug.trim().toLowerCase(), email.trim(), password);
    } catch (cause) {
      setError(friendlyError(cause, 'Sign in could not be completed. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <div className="login-topline">
      <a className="brand-lockup" href="/" aria-label="Myworkspace Front Desk">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span><b>MYWORKSPACE</b><small>FRONT DESK</small></span>
      </a>
      <span className="eyebrow login-note">STAFF ACCESS</span>
    </div>
    <div className="login-layout">
      <section className="login-statement">
        <p className="eyebrow">OPERATIONS / 01</p>
        <h1>Make room<br />for the day.</h1>
        <p className="login-subtitle">Bookings, arrivals and cash. One clear view for the people at the desk.</p>
        <div className="login-index-line"><span>01</span><span>MYWORKSPACE / FRONT DESK</span><span>SECURE SESSION</span></div>
      </section>
      <section className="login-card" aria-labelledby="login-heading">
        <div className="section-index">SIGN IN <span>— STAFF ONLY</span></div>
        <h2 id="login-heading">Your desk, ready.</h2>
        <p className="muted">Use your organisation credentials to continue.</p>
        <form onSubmit={submit} className="form-stack">
          <label className="field-label">Organisation slug
            <input required autoComplete="organization" value={orgSlug} onChange={e => setOrgSlug(e.target.value)} placeholder="e.g. acme-desks" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={60} />
          </label>
          <label className="field-label">Email address
            <input required type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" />
          </label>
          <label className="field-label">Password
            <input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" />
          </label>
          {error && <div className="form-alert" role="alert">{error}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={busy}>
            {busy ? 'Checking credentials…' : 'Sign in'} <span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className="login-footnote">Sign-in and workspace data are handled by your organisation’s front desk API.</p>
      </section>
    </div>
    <footer className="login-footer"><span>MYWORKSPACE / FRONT DESK</span><span>STAFF OPERATIONS</span><span>v1.0</span></footer>
  </main>;
}
