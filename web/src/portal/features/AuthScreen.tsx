import { useState, type FormEvent } from 'react';
import { login, register } from '../api/routes';
import { setToken } from '../api/client';
import type { PortalUser, RegisterPayload } from '../api/types';
import { friendlyError } from '../lib/errors';

const DEFAULT_SLUG: string = (import.meta.env.VITE_DEFAULT_ORG_SLUG as string | undefined) ?? '';

type Mode = 'login' | 'register';

export function AuthScreen({ onAuth }: { onAuth: (user: PortalUser, orgSlug: string) => void }) {
  const [mode, setMode] = useState<Mode>(DEFAULT_SLUG ? 'login' : 'login');
  const [orgSlug, setOrgSlug] = useState(DEFAULT_SLUG);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const cleanSlug = orgSlug.trim().toLowerCase();
      if (mode === 'login') {
        const result = await login(cleanSlug, email.trim(), password);
        setToken(result.token);
        onAuth(result.user, cleanSlug);
      } else {
        const payload: RegisterPayload = {
          orgSlug: cleanSlug,
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
        };
        const result = await register(payload);
        setToken(result.token);
        onAuth(result.user, cleanSlug);
      }
    } catch (cause) {
      setError(friendlyError(cause, 'That could not be completed. Please check the details and try again.'));
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page portal-login-page">
    <div className="login-topline">
      <a className="brand-lockup" href="/portal" aria-label="Myworkspace customer portal">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <span><b>MYWORKSPACE</b><small>BOOK A SPACE</small></span>
      </a>
      <span className="eyebrow login-note">CUSTOMER PORTAL</span>
    </div>
    <div className="login-layout">
      <section className="login-statement">
        <p className="eyebrow">SELF-SERVICE / 01</p>
        <h1>Reserve your<br />workspace.</h1>
        <p className="login-subtitle">Browse available desks, booths and meeting rooms, choose a time that suits you, and manage your bookings in one place.</p>
        <div className="login-index-line"><span>01</span><span>MYWORKSPACE / CUSTOMER PORTAL</span><span>ONLINE BOOKING</span></div>
      </section>
      <section className="login-card" aria-labelledby="portal-auth-heading">
        <div className="section-index">
          <span>{mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}</span>
          <span>
            <button type="button" className="text-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
              {mode === 'login' ? 'New here? Register' : 'Have an account? Sign in'}
            </button>
          </span>
        </div>
        <h2 id="portal-auth-heading">{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h2>
        <p className="muted">{mode === 'login' ? 'Sign in to view and manage your bookings.' : 'Registration takes a minute and lets you book spaces online.'}</p>
        <form onSubmit={submit} className="form-stack">
          <label className="field-label">Organisation slug
            <input required autoComplete="organization" value={orgSlug} onChange={e => setOrgSlug(e.target.value)} placeholder="e.g. mws-desks" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={60} />
          </label>
          {mode === 'register' && <>
            <label className="field-label">Full name
              <input required autoComplete="name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your name" maxLength={200} />
            </label>
            <label className="field-label">Phone <span className="optional-label">OPTIONAL</span>
              <input inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Contact number" maxLength={50} />
            </label>
          </>}
          <label className="field-label">Email address
            <input required type="email" autoComplete={mode === 'login' ? 'username' : 'email'} value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <label className="field-label">Password
            <input required type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'login' ? 'Enter your password' : 'At least 10 characters'} minLength={10} />
          </label>
          {error && <div className="form-alert" role="alert">{error}</div>}
          <button className="button button-primary login-submit" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className="login-footnote">Prefer to speak to the desk? Staff sign in at the <a href="/">front desk</a>.</p>
      </section>
    </div>
    <footer className="login-footer"><span>MYWORKSPACE / CUSTOMER PORTAL</span><span>SELF-SERVICE BOOKING</span><span>v1.0</span></footer>
  </main>;
}
