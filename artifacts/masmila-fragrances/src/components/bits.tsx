import { artworkFor, imageFor } from '@/lib/bottle';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, Check, Copy, Facebook, Heart, Instagram, Share2 } from 'lucide-react';
import { WhatsAppIcon } from '@/components/whatsapp-icon';
import QRCode from 'qrcode';
import { useQueryClient } from '@tanstack/react-query';
import { getListWishlistQueryKey, useAddToWishlist, useListWishlist, useRemoveFromWishlist, type Product } from '@workspace/api-client-react';
import { money, statusTone, humanise } from '@/lib/format';
import { useCart } from '@/lib/cart';
import { useMe } from '@/lib/auth';

export function ProductVisual({ product }: { product: Pick<Product, 'id' | 'image' | 'imageAlt' | 'name' | 'badge' | 'family' | 'size'> }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className="product-visual" data-testid={`visual-product-${product.id}`}>
      <img className="product-image" src={imageFailed ? artworkFor(product) : imageFor(product)} alt={product.imageAlt || product.name} loading="lazy" onError={() => setImageFailed(true)} />
      {product.badge ? <span className="product-badge">{product.badge}</span> : null}
    </div>
  );
}

export function PriceBlock({ product, compact = false }: { product: Pick<Product, 'price' | 'resellerPrice'>; compact?: boolean }) {
  if (product.resellerPrice != null) {
    return (
      <span className={`price-block ${compact ? 'compact' : ''}`} data-testid="price-reseller">
        <span className="price-retail-strike">Retail {money(product.price)}</span>
        <strong>Reseller {money(product.resellerPrice)}</strong>
      </span>
    );
  }
  return <strong className="price-single">{money(product.price)}</strong>;
}

export function ProductCard({ product }: { product: Product }) {
  const cart = useCart();
  const soldOut = product.stockStatus === 'out_of_stock';
  return (
    <article className="product-card reveal" data-testid={`card-product-${product.id}`}>
      <Link href={`/product/${product.slug}`} className="product-link" aria-label={`${product.name} ${product.size}`}>
        <ProductVisual product={product} />
      </Link>
      <div className="product-info">
        <span className="eyebrow">{product.family} · {product.category}</span>
        <h3 data-testid={`text-product-name-${product.id}`}><Link href={`/product/${product.slug}`}>{product.name}</Link></h3>
        <div className="product-meta"><span>{product.size} · {product.notes.slice(0, 2).join(', ')}</span><PriceBlock product={product} compact /></div>
        <button className="product-add" disabled={soldOut} onClick={() => cart.add(product)} data-testid={`button-add-product-${product.id}`}>
          {soldOut ? 'Sold out' : <>Add to bag <ArrowRight size={14} /></>}
        </button>
      </div>
    </article>
  );
}

export function LoadingGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="product-grid" data-testid="loading-products">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}><div className="skeleton" style={{ aspectRatio: '.82' }} /><div className="skeleton" style={{ height: 20, marginTop: 15, width: '65%' }} /><div className="skeleton" style={{ height: 13, marginTop: 9, width: '90%' }} /></div>
      ))}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }) {
  return <div className="loading-block" data-testid="state-loading"><span className="spinner" aria-hidden="true" />{label}…</div>;
}

export function ErrorState({ error, onRetry, title = 'We could not load this just now.' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const message = (error as { data?: { error?: string } })?.data?.error;
  return (
    <div className="error-state" data-testid="state-error">
      <span className="eyebrow">A small detour</span>
      <h2>{title}</h2>
      <p>{message ?? 'Please try again in a moment.'}</p>
      {onRetry ? <button className="btn-primary" onClick={onRetry} data-testid="button-retry">Try again <ArrowRight size={15} /></button> : null}
    </div>
  );
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`pill pill-${statusTone(status)}`}>{label ?? humanise(status)}</span>;
}

export function Metric({ label, value, detail, primary = false, testId }: { label: string; value: ReactNode; detail?: ReactNode; primary?: boolean; testId?: string }) {
  return (
    <div className={`metric-card ${primary ? 'primary' : ''}`} data-testid={testId}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {detail ? <span className="metric-detail">{detail}</span> : null}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="progress-wrap">
      {label ? <div className="rank-row"><span>{label}</span><span>{pct}%</span></div> : null}
      <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="progress-bar" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; badge?: number }>; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={value === tab.id} className={`tab ${value === tab.id ? 'on' : ''}`} onClick={() => onChange(tab.id)} data-testid={`tab-${tab.id}`}>
          {tab.label}{tab.badge ? <span className="tab-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><h2>{title}</h2>{children ? <p>{children}</p> : null}</div>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-ghost small"
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
      }}
      data-testid="button-copy"
    >
      {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> {label}</>}
    </button>
  );
}

export function QrCode({ value, size = 180 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, { width: size * 2, margin: 1, color: { dark: '#2d2738', light: '#ffffff' } })
      .then((url) => { if (active) setSrc(url); })
      .catch(() => setSrc(null));
    return () => { active = false; };
  }, [value, size]);
  if (!src) return <div className="skeleton" style={{ width: size, height: size }} />;
  return (
    <figure className="qr">
      <img src={src} width={size} height={size} alt={`QR code for ${value}`} data-testid="img-qr" />
      <a className="btn-ghost small" href={src} download="masmila-referral-qr.png">Download QR</a>
    </figure>
  );
}

/** Share-to-WhatsApp / Facebook / Instagram plus copy link. */
export function ShareButtons({ url, text }: { url: string; text: string }) {
  const [note, setNote] = useState<string | null>(null);
  const nativeShare = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "Mas'Mila", text, url }); } catch { /* dismissed */ }
    } else {
      await navigator.clipboard?.writeText(`${text} ${url}`);
      setNote('Link copied — paste it into your Instagram story or bio.');
    }
  };
  return (
    <div className="share-row">
      <a className="btn-ghost small" href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`} target="_blank" rel="noreferrer" data-testid="button-share-whatsapp"><WhatsAppIcon size={14} /> WhatsApp</a>
      <a className="btn-ghost small" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer" data-testid="button-share-facebook"><Facebook size={14} /> Facebook</a>
      <button className="btn-ghost small" type="button" onClick={() => void nativeShare()} data-testid="button-share-instagram"><Instagram size={14} /> Instagram</button>
      <button className="btn-ghost small" type="button" onClick={() => void nativeShare()} aria-label="More sharing options"><Share2 size={14} /></button>
      <CopyButton value={url} label="Copy link" />
      {note ? <small className="muted">{note}</small> : null}
    </div>
  );
}

/** Sign out, then return to this page through the sign-in screen. */
function SwitchAccountButton() {
  const { auth } = useMe();
  const [, navigate] = useLocation();
  const target = `/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  return (
    <button
      className="btn-primary"
      type="button"
      data-testid="button-switch-account"
      onClick={() => {
        if (auth.mode === 'demo') navigate(target);
        else void auth.signOut(target);
      }}
    >
      Switch account <ArrowRight size={15} />
    </button>
  );
}

export function RequireSignIn({ children, role }: { children: ReactNode; role?: 'reseller' | 'admin' }) {
  const { data: me, isLoading, auth, error, refetch } = useMe();
  if (!auth.ready || isLoading) return <main className="container-wide dashboard-wrap"><LoadingBlock label="Checking your access" /></main>;
  if (error) return <main className="container-wide dashboard-wrap"><ErrorState error={error} onRetry={() => void refetch()} /></main>;
  if (!me?.signedIn) {
    return (
      <main className="container-wide dashboard-wrap">
        <div className="empty-state" data-testid="state-sign-in-required">
          <span className="eyebrow">Members area</span>
          <h2>Please sign in to continue.</h2>
          <p>{role === 'reseller' ? 'The reseller portal is available to approved Mas\'Mila resellers.' : role === 'admin' ? 'This workspace is for Mas\'Mila administrators.' : 'Sign in to see your orders, addresses and wishlist.'}</p>
          <Link className="btn-primary" href={`/sign-in?next=${encodeURIComponent(window.location.pathname)}`}>Sign in <ArrowRight size={15} /></Link>
        </div>
      </main>
    );
  }
  if (role === 'admin' && !me.isAdmin) {
    return (
      <main className="container-wide dashboard-wrap">
        <div className="empty-state" data-testid="state-admin-only">
          <span className="eyebrow">Admin console</span>
          <h2>Administrator access only.</h2>
          <p>You're signed in as <strong>{me.user?.email}</strong>, which isn't an administrator account.</p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            <SwitchAccountButton />
            <Link className="btn-ghost" href={me.reseller ? '/account/reseller' : '/account'}>{me.reseller ? 'Go to my portal' : 'Go to my account'}</Link>
          </div>
        </div>
      </main>
    );
  }
  if (role === 'reseller' && !me.reseller) {
    return (
      <main className="container-wide dashboard-wrap">
        <div className="empty-state" data-testid="state-not-reseller">
          <span className="eyebrow">Reseller portal</span>
          <h2>{me.application?.status === 'pending' || me.application?.status === 'info_requested' ? 'Your application is being reviewed.' : 'You are not a Mas\'Mila reseller yet.'}</h2>
          <p>{me.application ? `Application ${me.application.applicationId}: ${humanise(me.application.status)}.${me.application.adminNote ? ` Note from Mas'Mila: ${me.application.adminNote}` : ''}` : 'Apply to become a reseller — once approved, this portal unlocks reseller pricing, ordering and your referral tools.'}</p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            {!me.application || me.application.status === 'rejected' ? <Link className="btn-primary" href="/become-a-reseller">Apply now <ArrowRight size={15} /></Link> : null}
            <SwitchAccountButton />
          </div>
        </div>
      </main>
    );
  }
  if (role === 'reseller' && me.reseller?.standing === 'suspended') return <main className="container-wide dashboard-wrap"><EmptyState title="Your reseller account is suspended.">Please contact Mas'Mila for assistance.</EmptyState></main>;
  return <>{children}</>;
}

export function WishlistButton({ productId }: { productId: number }) {
  const { data: me } = useMe();
  if (!me?.signedIn) return null;
  return <WishlistToggle productId={productId} />;
}

function WishlistToggle({ productId }: { productId: number }) {
  const queryClient = useQueryClient();
  const wishlist = useListWishlist({ query: { queryKey: getListWishlistQueryKey() } });
  const add = useAddToWishlist();
  const remove = useRemoveFromWishlist();
  const saved = Boolean(wishlist.data?.some((p) => p.id === productId));
  const toggle = () => {
    const done = { onSuccess: () => void queryClient.invalidateQueries({ queryKey: getListWishlistQueryKey() }) };
    if (saved) remove.mutate({ productId }, done);
    else add.mutate({ productId }, done);
  };
  return (
    <button className={`btn-ghost ${saved ? 'saved' : ''}`} type="button" onClick={toggle} aria-pressed={saved} data-testid="button-wishlist">
      <Heart size={15} fill={saved ? 'currentColor' : 'none'} /> {saved ? 'Saved' : 'Save to wishlist'}
    </button>
  );
}
