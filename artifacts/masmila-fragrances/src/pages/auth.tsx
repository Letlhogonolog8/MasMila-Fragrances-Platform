import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { SignIn, SignUp } from '@clerk/react';
import { ArrowRight } from 'lucide-react';
import { basePath, useAuthApi, useMe } from '@/lib/auth';
import { useStoreConfig } from '@/components/site';
import { useSeo } from '@/lib/seo';

const DEMO_ACCOUNTS = [
  { email: 'admin@masmila.co.za', label: 'Administrator' },
  { email: 'manager@masmila.co.za', label: 'Manager — Thandi' },
  { email: 'teamleader@masmila.co.za', label: 'Team Leader — Nomdade' },
  { email: 'reseller@masmila.co.za', label: 'Reseller — Ayanda' },
  { email: 'newreseller@masmila.co.za', label: 'New reseller (no opening order)' },
  { email: 'customer@masmila.co.za', label: 'Customer — Palesa' },
];

function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

function DemoSignIn({ next }: { next: string | null }) {
  const auth = useAuthApi();
  const config = useStoreConfig();
  const { data: me } = useMe();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState('');
  // Only redirect once the account picked on this page is active, so a
  // signed-in user can still come here to switch accounts.
  const [chosen, setChosen] = useState<string | null>(null);
  const home = (m: typeof me) => safeNext(next) ?? (m?.isAdmin ? '/admin' : m?.reseller ? '/account/reseller' : '/account');
  useEffect(() => {
    if (chosen && me?.user?.email === chosen) navigate(home(me));
  }, [me, chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  if (config.data?.authMode === 'none') {
    return <div className="form-card"><h2>Sign-in is not configured.</h2><p className="muted">Set VITE_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY to enable accounts.</p></div>;
  }
  const pick = (value: string) => {
    const normalised = value.trim().toLowerCase();
    if (!normalised) return;
    setChosen(normalised);
    auth.demoSignIn(normalised);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); pick(email); };
  return (
    <div className="form-card" data-testid="demo-sign-in">
      <span className="eyebrow">Demo sign-in · development only</span>
      <h2>{me?.signedIn ? 'Switch account' : 'Sign in'}</h2>
      {me?.signedIn && !chosen ? (
        <p className="notice">Signed in as <strong>{me.user?.email}</strong>. <button className="link-button" onClick={() => navigate(home(me))}>Continue as this account →</button></p>
      ) : null}
      <p className="muted small-text">Clerk is not configured, so you can sign in as any email (new emails become customer accounts). Pick a seeded account to explore each role:</p>
      <div className="demo-accounts">{DEMO_ACCOUNTS.map((a) => <button key={a.email} className="btn-ghost small" onClick={() => pick(a.email)} data-testid={`button-demo-${a.email.split('@')[0]}`}>{a.label}</button>)}</div>
      <form onSubmit={submit} className="form-grid mt"><div className="field full"><label htmlFor="demo-email">Email</label><input id="demo-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div><button className="btn-primary" type="submit">Continue <ArrowRight size={15} /></button></form>
    </div>
  );
}

export function SignInPage() {
  const auth = useAuthApi();
  const next = safeNext(new URLSearchParams(useSearch()).get('next'));
  useSeo({ title: 'Sign in', noindex: true });
  return (
    <main className="auth-page">
      {auth.mode === 'clerk'
        ? <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} fallbackRedirectUrl={`${basePath}${next ?? '/account'}`} />
        : <DemoSignIn next={next} />}
      <Link href="/" className="small-link">← Back to Mas'Mila</Link>
    </main>
  );
}

export function SignUpPage() {
  const auth = useAuthApi();
  useSeo({ title: 'Create an account', noindex: true });
  return (
    <main className="auth-page">
      {auth.mode === 'clerk' ? <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} fallbackRedirectUrl={`${basePath}/account`} /> : <DemoSignIn next="/account" />}
      <Link href="/" className="small-link">← Back to Mas'Mila</Link>
    </main>
  );
}

/** "Reseller Login" page from the site map — explains the portal, then signs in. */
export function ResellerLoginPage() {
  const { data: me } = useMe();
  const [, navigate] = useLocation();
  useSeo({ title: 'Reseller login', description: 'Sign in to the Mas\'Mila reseller portal to see reseller pricing, place stock orders and track your team.' });
  useEffect(() => { if (me?.reseller) navigate('/account/reseller'); }, [me, navigate]);
  return (
    <main className="container-wide form-shell">
      <div className="form-aside"><span className="eyebrow">Reseller login</span><h1 className="display-lg">Welcome back.</h1><p className="body-lg">Sign in with the email address you used on your reseller application to see reseller pricing, order stock, share your link and track your team.</p><p className="muted">Not a reseller yet? <Link href="/become-a-reseller">Apply here</Link>.</p></div>
      <div className="form-card" style={{ alignSelf: 'center' }}>
        <h2>Reseller portal</h2>
        <Link className="btn-primary block" href="/sign-in?next=/account/reseller" data-testid="button-reseller-sign-in">Sign in to the portal <ArrowRight size={15} /></Link>
      </div>
    </main>
  );
}
