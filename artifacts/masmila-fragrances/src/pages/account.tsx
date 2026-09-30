import { imageFor } from '@/lib/bottle';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowRight, Bell, Gauge, Gift, Heart, Package, RotateCcw, ShoppingBag, Sparkles, UserRound, Wallet } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMeQueryKey,
  getListMyOrdersQueryKey,
  getListNotificationsQueryKey,
  getListProductsQueryKey,
  getListWishlistQueryKey,
  listProducts,
  useListMyOrders,
  useListProducts,
  useListNotifications,
  useListWishlist,
  useMarkNotificationsRead,
  useUpdateMe,
  type Order,
} from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingBlock, ProductCard, RequireSignIn, StatusPill } from '@/components/bits';
import { DashboardShell, Kpi, type ShellItem } from '@/components/dashboard';
import { useMe } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { dateOnly, dateTime, errorMessage, money, PROVINCES, humanise } from '@/lib/format';
import { useSeo } from '@/lib/seo';
import { OrderDetail } from './order';

type Tab = 'overview' | 'orders' | 'profile' | 'wishlist' | 'notifications' | 'referral';

export function NotificationsList() {
  const queryClient = useQueryClient();
  const list = useListNotifications({ query: { queryKey: getListNotificationsQueryKey() } });
  const markRead = useMarkNotificationsRead();
  const unread = list.data?.some((n) => !n.read);
  useEffect(() => {
    if (unread) markRead.mutate(undefined, { onSuccess: () => void queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() }) });
  }, [unread]); // eslint-disable-line react-hooks/exhaustive-deps
  if (list.isLoading) return <LoadingBlock />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!list.data?.length) return <EmptyState title="No notifications yet.">Order updates, approvals and incentive notices will appear here.</EmptyState>;
  return (
    <div className="activity-list" data-testid="list-notifications">
      {list.data.map((n) => (
        <div className={`activity-item ${n.read ? '' : 'unread'}`} key={n.id}>
          <i className="activity-dot" />
          <div><strong>{n.title}</strong><span>{n.body}</span>{n.link ? <Link href={n.link} className="small-link">View →</Link> : null}</div>
          <time>{dateTime(n.createdAt)}</time>
        </div>
      ))}
    </div>
  );
}

function OrdersTab() {
  const orders = useListMyOrders({ query: { queryKey: getListMyOrdersQueryKey() } });
  const cart = useCart();
  const [, navigate] = useLocation();
  const search = new URLSearchParams(useSearch());
  const [open, setOpen] = useState<string | null>(search.get('order'));
  const [reordering, setReordering] = useState<string | null>(null);
  const images = useProductImages();

  const reorder = async (order: Order) => {
    setReordering(order.orderNumber);
    try {
      const products = await listProducts({ limit: 200 });
      for (const item of order.items) {
        const product = products.find((p) => p.id === item.productId);
        if (product && product.stockStatus !== 'out_of_stock') cart.add(product, item.quantity);
      }
      cart.setMode(order.channel === 'reseller' ? 'reseller' : 'retail');
      navigate('/cart');
    } finally {
      setReordering(null);
    }
  };

  if (orders.isLoading) return <LoadingBlock label="Loading orders" />;
  if (orders.error) return <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />;
  if (!orders.data?.length) return <EmptyState title="No orders yet.">When you place an order it will appear here with live tracking.</EmptyState>;
  return (
    <div className="order-list">
      {orders.data.map((o) => (
        <div key={o.id} className="dash-card order-card">
          <button className="order-summary-row" onClick={() => setOpen(open === o.orderNumber ? null : o.orderNumber)} aria-expanded={open === o.orderNumber} data-testid={`button-order-${o.orderNumber}`}>
            <span className="order-row-main"><ProductThumbs order={o} images={images} /><span><strong>{o.orderNumber}</strong><small>{dateOnly(o.createdAt)} · {o.bottles} bottle{o.bottles === 1 ? '' : 's'}{o.channel === 'reseller' ? ' · reseller order' : ''}</small></span></span>
            <span className="order-summary-right"><StatusPill status={o.status} /><strong>{money(o.total)}</strong></span>
          </button>
          {open === o.orderNumber ? (
            <>
              <OrderDetail order={o} />
              <button className="btn-ghost small" onClick={() => void reorder(o)} disabled={reordering === o.orderNumber} data-testid={`button-reorder-${o.orderNumber}`}><RotateCcw size={14} /> {reordering === o.orderNumber ? 'Adding…' : 'Reorder'}</button>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ProfileTab() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const update = useUpdateMe({ mutation: { meta: { success: 'Profile saved' } } });
  const u = me!.user!;
  const [form, setForm] = useState({
    firstName: u.firstName, surname: u.surname, mobile: u.mobile ?? '', addressLine1: u.addressLine1 ?? '', addressLine2: u.addressLine2 ?? '',
    suburb: u.suburb ?? '', city: u.city ?? '', province: u.province ?? '', postalCode: u.postalCode ?? '', marketingOptIn: u.marketingOptIn,
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({ data: { ...form, mobile: form.mobile || null, addressLine2: form.addressLine2 || null } }, { onSuccess: (data) => queryClient.setQueryData(getGetMeQueryKey(), data) });
  };
  const input = (k: keyof typeof form, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field"><label htmlFor={`p-${k}`}>{label}</label><input id={`p-${k}`} value={String(form[k])} onChange={(e) => set(k, e.target.value)} {...extra} /></div>
  );
  return (
    <form className="form-card" onSubmit={submit} data-testid="form-profile">
      <h2>Profile</h2>
      <p className="muted">Signed in as <strong>{u.email}</strong></p>
      <div className="form-grid">{input('firstName', 'First name', { required: true })}{input('surname', 'Surname', { required: true })}{input('mobile', 'Mobile', { type: 'tel' })}</div>
      <h2 className="mt">Saved delivery address</h2>
      <div className="form-grid">
        {input('addressLine1', 'Street address')}{input('addressLine2', 'Complex / unit')}{input('suburb', 'Suburb')}{input('city', 'City / town')}
        <div className="field"><label htmlFor="p-province">Province</label><select id="p-province" value={form.province} onChange={(e) => set('province', e.target.value)}><option value="">—</option>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></div>
        {input('postalCode', 'Postal code', { pattern: '[0-9]{4}', inputMode: 'numeric' })}
      </div>
      <label className="check-row"><input type="checkbox" checked={form.marketingOptIn} onChange={(e) => set('marketingOptIn', e.target.checked)} /><span>Send me launches and promotions (you can opt out at any time).</span></label>
      <div className="submit-row">{update.isSuccess ? <span className="ok-text">Saved.</span> : update.error ? <span className="form-message">{errorMessage(update.error)}</span> : <span />}<button className="btn-primary" type="submit" disabled={update.isPending}>Save <ArrowRight size={15} /></button></div>
    </form>
  );
}

function WishlistTab() {
  const wishlist = useListWishlist({ query: { queryKey: getListWishlistQueryKey() } });
  if (wishlist.isLoading) return <LoadingBlock />;
  if (!wishlist.data?.length) return <EmptyState title="Your wishlist is empty.">Tap “Save to wishlist” on any fragrance to keep it here.</EmptyState>;
  return <div className="product-grid">{wishlist.data.map((p) => <ProductCard key={p.id} product={p} />)}</div>;
}

function ReferralTab() {
  const { data: me } = useMe();
  if (me?.reseller) {
    return <div className="dash-card"><h2>Your reseller tools</h2><p>Your referral code is <strong className="font-mono-brand">{me.reseller.referralCode}</strong>. Share links, QR codes and track attributed sales in your portal.</p><Link className="btn-primary" href="/account/reseller?tab=share">Open reseller portal <ArrowRight size={15} /></Link></div>;
  }
  return (
    <div className="dash-card">
      <h2>Sell Mas'Mila</h2>
      {me?.application ? <p>Your reseller application <strong>{me.application.applicationId}</strong> is <StatusPill status={me.application.status} />{me.application.adminNote ? <> — “{me.application.adminNote}”</> : null}</p> : <p>Love the scents? Become a reseller: buy at wholesale prices, sell at retail and build your own fragrance business.</p>}
      {!me?.application || me.application.status === 'rejected' ? <Link className="btn-primary" href="/become-a-reseller">BECOME A RESELLER <ArrowRight size={15} /></Link> : null}
    </div>
  );
}

function OverviewTab({ goTo }: { goTo: (t: Tab) => void }) {
  const { data: me } = useMe();
  const orders = useListMyOrders({ query: { queryKey: getListMyOrdersQueryKey() } });
  const wishlist = useListWishlist({ query: { queryKey: getListWishlistQueryKey() } });
  const images = useProductImages();
  const list = orders.data ?? [];
  const paid = list.filter((o) => !['cancelled', 'awaiting_payment'].includes(o.status));
  const latest = list[0];
  const inTransit = list.filter((o) => ['paid', 'processing', 'shipped'].includes(o.status)).length;
  if (orders.isLoading) return <LoadingBlock />;
  return (
    <>
      <section className="portal-hero account-hero">
        <div className="portal-hero-copy">
          <span className="rank-badge"><Sparkles size={13} /> {me?.reseller ? 'Reseller' : 'Mas\'Mila customer'}</span>
          <h2>Hello{me?.user?.firstName ? `, ${me.user.firstName}` : ''}.</h2>
          <p>{latest ? <>Your latest order <strong>{latest.orderNumber}</strong> is <strong>{humanise(latest.status)}</strong>.</> : 'Find a scent you love — your orders and tracking will live here.'}</p>
          <div className="chip-row"><Link className="btn-primary small" href="/shop">Shop fragrances <ArrowRight size={13} /></Link>{me?.reseller ? <Link className="btn-ghost small light" href="/account/reseller">Reseller portal</Link> : null}{me?.isAdmin ? <Link className="btn-ghost small light" href="/admin">Admin</Link> : null}</div>
        </div>
      </section>
      <div className="kpi-grid">
        <Kpi tone="primary" icon={Package} label="Orders" value={list.length} detail={`${inTransit} on the way`} />
        <Kpi icon={ShoppingBag} label="Bottles bought" value={paid.reduce((s, o) => s + o.bottles, 0)} />
        <Kpi icon={Wallet} label="Total spent" value={money(paid.reduce((s, o) => s + o.total, 0))} />
        <Kpi icon={Heart} label="Wishlist" value={wishlist.data?.length ?? 0} detail={<button className="link-button" onClick={() => goTo('wishlist')}>View saved scents</button>} />
      </div>
      {latest ? (
        <section className="dash-card">
          <div className="card-head"><h2>Latest order</h2><button className="btn-ghost small" onClick={() => goTo('orders')}>All orders</button></div>
          <ProductThumbs order={latest} images={images} />
          <OrderDetail order={latest} />
        </section>
      ) : null}
      {wishlist.data?.length ? (
        <section className="section-tight"><div className="card-head"><h2 className="display-sm">Saved for later</h2></div><div className="product-grid">{wishlist.data.slice(0, 4).map((p) => <ProductCard key={p.id} product={p} />)}</div></section>
      ) : null}
    </>
  );
}

/** productId → image, from the (cached) catalogue. */
function useProductImages() {
  const params = { limit: 200 };
  const products = useListProducts(params, { query: { queryKey: getListProductsQueryKey(params), staleTime: 5 * 60_000 } });
  return new Map((products.data ?? []).map((p) => [p.id, imageFor(p)]));
}

function ProductThumbs({ order, images }: { order: Order; images: Map<number, string> }) {
  return (
    <div className="thumbs">
      {order.items.slice(0, 5).map((i) => (images.get(i.productId) ? <img key={i.id} src={images.get(i.productId)} alt={`${i.name} ${i.size}`} title={`${i.quantity} × ${i.name} ${i.size}`} /> : null))}
      {order.items.length > 5 ? <span>+{order.items.length - 5}</span> : null}
    </div>
  );
}

export default function AccountPage() {
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const tab = (search.get('tab') as Tab) || 'overview';
  const { data: me } = useMe();
  useSeo({ title: 'My account', noindex: true });
  const setTab = (t: Tab) => navigate(`/account?tab=${t}`);
  const items: Array<ShellItem<Tab>> = [
    { id: 'overview', label: 'Overview', icon: Gauge, primary: true },
    { id: 'orders', label: 'Orders & tracking', icon: Package, primary: true },
    { id: 'wishlist', label: 'Wishlist', icon: Heart, primary: true },
    { id: 'profile', label: 'Profile & address', icon: UserRound, primary: true },
    { id: 'notifications', label: 'Notifications', icon: Bell, badge: me?.unreadNotifications },
    { id: 'referral', label: me?.reseller ? 'Referral tools' : 'Become a reseller', icon: Gift },
  ];
  return (
    <RequireSignIn>
      <DashboardShell eyebrow="My account" title={`${me?.user?.firstName ?? ''} ${me?.user?.surname ?? ''}`.trim() || 'My account'} subtitle={me?.user?.email} items={items} active={tab} onSelect={setTab}
        actions={<Link href="/track-order" className="btn-ghost small">Track an order</Link>}>
        {tab === 'overview' ? <OverviewTab goTo={setTab} /> : tab === 'orders' ? <OrdersTab /> : tab === 'profile' ? <ProfileTab /> : tab === 'wishlist' ? <WishlistTab /> : tab === 'notifications' ? <NotificationsList /> : <ReferralTab />}
      </DashboardShell>
    </RequireSignIn>
  );
}
