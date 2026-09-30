import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Bell, Menu, MessageCircle, ShoppingBag, User, X } from 'lucide-react';
import { useGetStoreConfig, useSubscribeNewsletter, getGetStoreConfigQueryKey } from '@workspace/api-client-react';
import { useCart } from '@/lib/cart';
import { useMe } from '@/lib/auth';
import { analyticsConfigured, consentState, setConsent, startAnalytics, trackPage } from '@/lib/analytics';
import { ThemeToggle } from '@/components/theme';
import { getReferral } from '@/lib/referral';
import { errorMessage } from '@/lib/format';

export function useStoreConfig() {
  return useGetStoreConfig({ query: { queryKey: getGetStoreConfigQueryKey(), staleTime: 5 * 60_000 } });
}

export function whatsappLink(number: string | undefined, text: string) {
  const digits = (number ?? '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

const NAV = [
  { href: '/shop', label: 'Shop' },
  { href: '/shop/women', label: 'Women' },
  { href: '/shop/men', label: 'Men' },
  { href: '/shop/unisex', label: 'Unisex' },
  { href: '/our-story', label: 'Our story' },
  { href: '/become-a-reseller', label: 'Become a reseller' },
];

function AnnouncementBar() {
  const referral = getReferral();
  return (
    <div className="announcement" data-testid="announcement-bar">
      {referral?.name ? <span>You're shopping with <strong>{referral.name}</strong>, your Mas'Mila reseller</span> : <span>Free delivery on orders over R750 · Nationwide courier across South Africa</span>}
    </div>
  );
}

export function Nav() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const cart = useCart();
  const { data: me, auth } = useMe();
  useEffect(() => setOpen(false), [location]);
  const accountHref = me?.isAdmin ? '/admin' : me?.reseller ? '/account/reseller' : '/account';
  return (
    <header className="container-wide site-nav" data-testid="navigation">
      <Link href="/" className="brand-mark" data-testid="link-home">Mas<span>'</span>Mila</Link>
      <nav className={`nav-links ${open ? 'open' : ''}`} aria-label="Main navigation">
        {NAV.map((link) => (
          <Link key={link.href} href={link.href} className={`nav-link ${location === link.href ? 'active' : ''}`} data-testid={`link-nav-${link.label.toLowerCase().replaceAll(' ', '-')}`}>{link.label}</Link>
        ))}
        {me?.signedIn ? <button className="nav-link mobile-only" type="button" onClick={() => void auth.signOut()} data-testid="button-sign-out-mobile">Sign out</button> : null}
      </nav>
      <div className="nav-actions">
        <ThemeToggle />
        {me?.signedIn ? (
          <>
            <Link href={`${accountHref}?tab=notifications`} className="icon-button notif-button" aria-label={`${me.unreadNotifications} unread notifications`} data-testid="link-notifications">
              <Bell size={16} />{me.unreadNotifications ? <span className="notif-dot">{me.unreadNotifications > 9 ? '9+' : me.unreadNotifications}</span> : null}
            </Link>
            <Link href={accountHref} className="nav-link desktop-only" data-testid="link-account">{me.isAdmin ? 'Admin' : me.reseller ? 'Portal' : 'Account'}</Link>
            <button className="nav-link desktop-only" type="button" onClick={() => void auth.signOut()} data-testid="button-sign-out">Sign out</button>
          </>
        ) : (
          <Link href="/sign-in" className="icon-button" aria-label="Sign in" data-testid="link-sign-in"><User size={16} /></Link>
        )}
        <Link href="/cart" className="bag-button" data-testid="button-open-bag"><ShoppingBag size={15} /> Bag ({cart.count})</Link>
        <button className="icon-button mobile-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Close menu' : 'Open menu'} data-testid="button-mobile-menu">{open ? <X size={18} /> : <Menu size={18} />}</button>
      </div>
    </header>
  );
}

/** Email / WhatsApp opt-in. `light` suits light page sections; default is for the dark footer. */
export function Newsletter({ light = false, defaultChannel = 'email' }: { light?: boolean; defaultChannel?: 'email' | 'whatsapp' }) {
  const subscribe = useSubscribeNewsletter();
  const [channel, setChannel] = useState<'email' | 'whatsapp'>(defaultChannel);
  const [contact, setContact] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    subscribe.mutate({ data: { channel, contact } }, { onSuccess: () => setContact('') });
  };
  return (
    <form className={`newsletter ${light ? 'newsletter-light' : ''}`} onSubmit={submit} data-testid={light ? 'form-optin' : 'form-newsletter'}>
      <div className="segmented" role="radiogroup" aria-label="Opt-in channel">
        <button type="button" className={channel === 'email' ? 'on' : ''} onClick={() => setChannel('email')}>Email</button>
        <button type="button" className={channel === 'whatsapp' ? 'on' : ''} onClick={() => setChannel('whatsapp')}>WhatsApp</button>
      </div>
      <div className="newsletter-row">
        <input required minLength={5} value={contact} onChange={(e) => setContact(e.target.value)} type={channel === 'email' ? 'email' : 'tel'} placeholder={channel === 'email' ? 'you@example.com' : '071 234 5678'} aria-label={channel === 'email' ? 'Email address' : 'WhatsApp number'} data-testid="input-newsletter" />
        <button className="btn-primary" disabled={subscribe.isPending} type="submit">Join</button>
      </div>
      {subscribe.isSuccess ? <small>You're on the list — launches and offers coming your way.</small> : null}
      {subscribe.error ? <small>{errorMessage(subscribe.error)}</small> : null}
      <small className="muted">By joining you agree to receive promotional messages. Unsubscribe anytime (POPIA).</small>
    </form>
  );
}

export function Footer() {
  const config = useStoreConfig();
  return (
    <footer className="footer">
      <div className="container-wide footer-grid footer-grid-5">
        <div>
          <Link href="/" className="brand-mark" data-testid="link-footer-home">Mas<span>'</span>Mila</Link>
          <p>Wear the fragrance. Build the business. Made in South Africa, shared wherever you are.</p>
          <Newsletter />
        </div>
        <div><h4>Shop</h4>
          <Link className="footer-link" href="/shop">All fragrances</Link>
          <Link className="footer-link" href="/shop/women">Women's fragrances</Link>
          <Link className="footer-link" href="/shop/men">Men's fragrances</Link>
          <Link className="footer-link" href="/shop/unisex">Unisex</Link>
          <Link className="footer-link" href="/shop/new-arrivals">New arrivals</Link>
          <Link className="footer-link" href="/shop/best-sellers">Best sellers</Link>
        </div>
        <div><h4>Mas'Mila</h4>
          <Link className="footer-link" href="/about">About Mas'Mila</Link>
          <Link className="footer-link" href="/our-story">Our story</Link>
          <Link className="footer-link" href="/corporate">Corporate & bulk orders</Link>
          <Link className="footer-link" href="/contact">Contact</Link>
          <Link className="footer-link" href="/faqs">FAQs</Link>
          <Link className="footer-link" href="/track-order">Track your order</Link>
        </div>
        <div><h4>Resellers</h4>
          <Link className="footer-link" href="/become-a-reseller">Become a reseller</Link>
          <Link className="footer-link" href="/how-reselling-works">How reselling works</Link>
          <Link className="footer-link" href="/reseller-login">Reseller login</Link>
          <Link className="footer-link" href="/account/reseller">Reseller dashboard</Link>
          <Link className="footer-link" href="/reseller-terms">Reseller terms</Link>
        </div>
        <div><h4>Help</h4>
          <Link className="footer-link" href="/shipping">Shipping & delivery</Link>
          <Link className="footer-link" href="/returns">Returns & refunds</Link>
          <Link className="footer-link" href="/privacy">Privacy policy</Link>
          <Link className="footer-link" href="/terms">Terms & conditions</Link>
          <Link className="footer-link" href="/cookies">Cookie policy</Link>
          {config.data?.whatsappNumber ? <a className="footer-link" href={whatsappLink(config.data.whatsappNumber, "Hi Mas'Mila!")} target="_blank" rel="noreferrer">WhatsApp us</a> : null}
        </div>
      </div>
      <div className="container-wide footer-bottom"><span>© {new Date().getFullYear()} Mas'Mila Fragrances · Prices in ZAR incl. VAT</span><span>Johannesburg · South Africa</span></div>
    </footer>
  );
}

export function WhatsAppFloat() {
  const config = useStoreConfig();
  const [location] = useLocation();
  if (!config.data?.whatsappNumber || location.startsWith('/admin')) return null;
  return (
    <a className="whatsapp-float" href={whatsappLink(config.data.whatsappNumber, "Hi Mas'Mila, I'd like help choosing a fragrance.")} target="_blank" rel="noreferrer" aria-label="Chat on WhatsApp" data-testid="link-whatsapp-chat">
      <MessageCircle size={20} /><span>Chat on WhatsApp</span>
    </a>
  );
}

export function CookieBanner() {
  const [state, setState] = useState(consentState);
  useEffect(() => { startAnalytics(); }, []);
  if (state || !analyticsConfigured) return null;
  const choose = (value: 'accepted' | 'declined') => { setConsent(value); setState(value); };
  return (
    <div className="cookie-banner" role="dialog" aria-label="Cookie consent" data-testid="cookie-banner">
      <p>We use cookies for analytics and marketing (Google Analytics, Meta and TikTok pixels) to improve Mas'Mila. <Link href="/cookies">Cookie policy</Link></p>
      <div><button className="btn-ghost" onClick={() => choose('declined')}>Decline</button><button className="btn-primary" onClick={() => choose('accepted')}>Accept</button></div>
    </div>
  );
}

export function PageTracker() {
  const [location] = useLocation();
  useEffect(() => {
    trackPage(location);
    window.scrollTo(0, 0);
  }, [location]);
  return null;
}

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site-shell">
      <AnnouncementBar />
      <Nav />
      {children}
      <Footer />
      <WhatsAppFloat />
      <CookieBanner />
      <PageTracker />
    </div>
  );
}
