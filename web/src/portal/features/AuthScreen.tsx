import { useEffect, useState, type FormEvent } from 'react';
import { defaultOrg, login, register } from '../api/routes';
import { setToken } from '../api/client';
import type { PortalUser, PublicOrg, RegisterPayload } from '../api/types';
import { friendlyError } from '../lib/errors';

// Pinned at build time (VITE_DEFAULT_ORG_SLUG) when a single workspace hosts
// this portal. When empty, the form asks the API for the default organisation
// and hides the slug field once it resolves; manual entry remains as a
// fallback for multi-workspace deployments or when the lookup fails.
const DEFAULT_SLUG: string = (import.meta.env.VITE_DEFAULT_ORG_SLUG as string | undefined) ?? '';

type Mode = 'login' | 'register';

export function AuthScreen({ onAuth }: { onAuth: (user: PortalUser, orgSlug: string) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [orgSlug, setOrgSlug] = useState(DEFAULT_SLUG);
  const [orgName, setOrgName] = useState('');
  const [slugResolved, setSlugResolved] = useState(DEFAULT_SLUG.length > 0);
  const [resolvingSlug, setResolvingSlug] = useState(DEFAULT_SLUG.length === 0);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (DEFAULT_SLUG) return;
    let active = true;
    defaultOrg()
      .then((result: { org: PublicOrg }) => {
        if (!active) return;
        setOrgSlug(result.org.slug);
        setOrgName(result.org.name);
        setSlugResolved(true);
      })
      .catch(() => {
        if (active) setSlugResolved(false);
      })
      .finally(() => {
        if (active) setResolvingSlug(false);
      });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanSlug = orgSlug.trim().toLowerCase();
    if (!cleanSlug) {
      setError('Enter the organisation slug provided by your workspace.');
      return;
    }
    setBusy(true);
    setError('');
    try {
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
          ...(company.trim() ? { company: company.trim() } : {}),
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
          {resolvingSlug ? (
            <p className="small-note">Preparing this workspace…</p>
          ) : slugResolved && orgSlug ? (
            <div className="field-label">Organisation
              <div className="read-only-field" aria-live="polite">{orgName || orgSlug}</div>
            </div>
          ) : (
            <label className="field-label">Organisation slug
              <input required name="orgSlug" autoComplete="organization" value={orgSlug} onChange={e => setOrgSlug(e.target.value)} placeholder="e.g. mws-desks" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={60} />
            </label>
          )}
          {mode === 'register' && <>
            <label className="field-label">Full name
              <input required name="fullName" autoComplete="name" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your name" maxLength={200} />
            </label>
            <label className="field-label">Phone <span className="optional-label">OPTIONAL</span>
              <input name="phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Contact number" maxLength={50} />
            </label>
            <label className="field-label">Company / employer <span className="optional-label">OPTIONAL</span>
              <input name="company" autoComplete="organization" value={company} onChange={e => setCompany(e.target.value)} placeholder="Where do you work?" maxLength={200} />
            </label>
          </>}
          <label className="field-label">Email address
            <input required name="email" type="email" spellCheck={false} autoComplete={mode === 'login' ? 'username' : 'email'} value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <label className="field-label">Password
            <input required name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'login' ? 'Enter your password' : 'At least 10 characters'} minLength={10} />
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
