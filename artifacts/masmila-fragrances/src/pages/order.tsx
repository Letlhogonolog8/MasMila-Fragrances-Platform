import { type FormEvent, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowRight, Check, Package, Truck } from 'lucide-react';
import { getTrackOrderQueryKey, useTrackOrder, type Order } from '@workspace/api-client-react';
import { CopyButton, ErrorState, LoadingBlock, StatusPill } from '@/components/bits';
import { useStoreConfig } from '@/components/site';
import { dateTime, money } from '@/lib/format';
import { useSeo } from '@/lib/seo';

const STEPS = [
  { key: 'placed', label: 'Order placed' },
  { key: 'paid', label: 'Payment received' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
];

export function OrderTimeline({ order }: { order: Order }) {
  const reached = {
    placed: true,
    paid: Boolean(order.paidAt),
    shipped: Boolean(order.shippedAt) || order.status === 'delivered',
    delivered: Boolean(order.deliveredAt),
  } as Record<string, boolean>;
  if (['cancelled', 'refunded'].includes(order.status)) return <p className="form-message">This order was {order.status}.</p>;
  return (
    <ol className="timeline" data-testid="order-timeline">
      {STEPS.map((s) => <li key={s.key} className={reached[s.key] ? 'done' : ''}><span>{reached[s.key] ? <Check size={12} /> : null}</span>{s.label}</li>)}
    </ol>
  );
}

export function OrderDetail({ order }: { order: Order }) {
  const config = useStoreConfig();
  return (
    <div className="order-detail" data-testid={`order-${order.orderNumber}`}>
      <div className="order-head"><div><span className="eyebrow">Order {order.orderNumber}</span><h3>{dateTime(order.createdAt)}</h3></div><StatusPill status={order.status} /></div>
      <OrderTimeline order={order} />
      {order.status === 'awaiting_payment' && order.paymentMethod === 'eft' ? (
        <div className="notice"><strong>Awaiting EFT payment of {money(order.total)}.</strong> Use reference <code>{order.orderNumber}</code> <CopyButton value={order.orderNumber} label="Copy ref" />{config.data?.bankDetails ? <><br />{config.data.bankDetails}</> : null}</div>
      ) : null}
      {order.trackingNumber ? <p className="notice"><Truck size={14} /> {order.courier ?? 'Courier'} tracking number: <strong>{order.trackingNumber}</strong></p> : null}
      <table className="table compact"><tbody>
        {order.items.map((i) => <tr key={i.id}><td>{i.quantity} × <Link href={`/product/${i.slug}`}>{i.name}</Link> {i.size}{i.refundedQuantity ? <small className="muted"> ({i.refundedQuantity} refunded)</small> : null}</td><td className="num">{money(i.lineTotal)}</td></tr>)}
        <tr><td>Delivery</td><td className="num">{order.shippingFee ? money(order.shippingFee) : 'Free'}</td></tr>
        <tr className="total"><td>Total</td><td className="num">{money(order.total)}</td></tr>
      </tbody></table>
      <p className="muted small-text"><Package size={13} /> Delivering to {order.shippingAddress}</p>
    </div>
  );
}

/** Order confirmation + public tracking: /order/:number?email=… and /track-order */
export default function OrderPage({ orderNumber }: { orderNumber?: string }) {
  const params = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const [form, setForm] = useState({ orderNumber: orderNumber ?? '', email: params.get('email') ?? '' });
  const lookup = { orderNumber: orderNumber ?? '', email: params.get('email') ?? '' };
  const enabled = Boolean(lookup.orderNumber && lookup.email);
  const order = useTrackOrder(lookup, { query: { queryKey: getTrackOrderQueryKey(lookup), enabled, retry: false } });
  const isNew = params.get('new') === '1';
  useSeo({ title: isNew ? 'Order confirmed' : 'Track your order', noindex: true });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/order/${encodeURIComponent(form.orderNumber.trim().toUpperCase())}?email=${encodeURIComponent(form.email.trim())}`);
  };

  return (
    <main className="container-wide form-shell">
      <div className="form-aside">
        <span className="eyebrow">{isNew ? 'Thank you' : 'Order tracking'}</span>
        <h1 className="display-lg">{isNew ? 'Your order is in.' : 'Where is my order?'}</h1>
        <p className="body-lg">{isNew ? 'A confirmation has been sent to your email. Save your order number to track delivery.' : 'Enter your order number and the email you used at checkout.'}</p>
        {isNew ? <Link className="btn-ghost" href="/shop">Continue shopping <ArrowRight size={15} /></Link> : null}
      </div>
      <div className="form-card">
        {!enabled ? (
          <form onSubmit={submit} data-testid="form-track-order">
            <h2>Track an order</h2>
            <div className="form-grid">
              <div className="field full"><label htmlFor="orderNumber">Order number</label><input id="orderNumber" required placeholder="MM-260101-1234" value={form.orderNumber} onChange={(e) => setForm({ ...form, orderNumber: e.target.value })} data-testid="input-order-number" /></div>
              <div className="field full"><label htmlFor="trackEmail">Email address</label><input id="trackEmail" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="input-track-email" /></div>
            </div>
            <div className="submit-row"><span className="count-label">Signed in? See all orders in your account.</span><button className="btn-primary" type="submit">Track order <ArrowRight size={15} /></button></div>
          </form>
        ) : order.isLoading ? <LoadingBlock label="Finding your order" /> : order.error || !order.data ? (
          <><ErrorState error={order.error} title="Order not found." /><p style={{ textAlign: 'center' }}><Link className="btn-ghost" href="/track-order">Try again</Link></p></>
        ) : <OrderDetail order={order.data} />}
      </div>
    </main>
  );
}
