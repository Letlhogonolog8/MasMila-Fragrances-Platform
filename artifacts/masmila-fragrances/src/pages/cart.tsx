import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, Minus, Plus, Trash2 } from 'lucide-react';
import { useCheckout, type CheckoutInput } from '@workspace/api-client-react';
import { EmptyState } from '@/components/bits';
import { useStoreConfig } from '@/components/site';
import { type CartLine, useCart } from '@/lib/cart';
import { useMe } from '@/lib/auth';
import { bulkDiscount, discounted, errorMessage, money, PROVINCES } from '@/lib/format';
import { clearReferral, getReferral } from '@/lib/referral';
import { useSeo } from '@/lib/seo';
import { track } from '@/lib/analytics';

/**
 * Bag totals exactly as the server will charge them: reseller stock orders get
 * the admin-configured bulk discount, and delivery is based on the discounted subtotal.
 */
function useTotals() {
  const cart = useCart();
  const config = useStoreConfig();
  const bulk = cart.mode === 'reseller' ? bulkDiscount(config.data?.bulkDiscountTiers, cart.count) : { percent: 0, next: null };
  const price = (line: CartLine) => discounted(cart.unitPrice(line), bulk.percent);
  const subtotal = Math.round(cart.lines.reduce((sum, l) => sum + price(l) * l.quantity, 0) * 100) / 100;
  const shipping = config.data ? (subtotal >= config.data.freeShippingThreshold ? 0 : config.data.shippingFlatRate) : 0;
  return { bulk, price, subtotal, shipping };
}

export function CartPage() {
  const cart = useCart();
  const config = useStoreConfig();
  const { data: me } = useMe();
  useSeo({ title: 'Your bag', noindex: true });
  const isReseller = Boolean(me?.reseller);
  useEffect(() => { if (!isReseller && cart.mode === 'reseller') cart.setMode('retail'); }, [isReseller]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cart.lines.length) {
    return <main className="container-wide dashboard-wrap"><EmptyState title="Your bag is empty.">Find a scent you love — or a gift for someone who deserves it.</EmptyState><p style={{ textAlign: 'center' }}><Link className="btn-primary" href="/shop">SHOP MAS'MILA <ArrowRight size={15} /></Link></p></main>;
  }
  const { bulk, price, subtotal, shipping } = useTotals();
  const minimum = cart.mode === 'reseller' && config.data ? (me?.reseller?.openingOrderCompleted ? config.data.reorderMinimum : config.data.openingOrder) : 0;
  const belowMinimum = cart.mode === 'reseller' && cart.count < minimum;
  const missingResellerPrice = cart.mode === 'reseller' && cart.lines.some((l) => l.resellerPrice == null);

  return (
    <main className="container-wide dashboard-wrap">
      <div className="dashboard-top"><div><span className="eyebrow">Your bag</span><h1 className="display-md">{cart.count} bottle{cart.count === 1 ? '' : 's'}</h1></div></div>
      {isReseller ? (
        <div className="segmented wide" role="radiogroup" aria-label="Order type" data-testid="toggle-order-mode">
          <button type="button" className={cart.mode === 'retail' ? 'on' : ''} onClick={() => cart.setMode('retail')}>Personal / retail purchase</button>
          <button type="button" className={cart.mode === 'reseller' ? 'on' : ''} onClick={() => cart.setMode('reseller')}>Reseller stock order (wholesale)</button>
        </div>
      ) : null}
      <div className="checkout-grid">
        <section className="dash-card">
          <div className="cart-lines">
            {cart.lines.map((line) => (
              <div className="cart-line" key={line.productId} data-testid={`cart-line-${line.productId}`}>
                <img src={line.image} alt="" />
                <div><Link href={`/product/${line.slug}`}><strong>{line.name}</strong></Link><small>{line.size} · {money(price(line))} each</small></div>
                <div className="qty small">
                  <button type="button" onClick={() => cart.setQuantity(line.productId, line.quantity - 1)} aria-label="Decrease"><Minus size={12} /></button>
                  <input aria-label={`Quantity for ${line.name}`} value={line.quantity} inputMode="numeric" onChange={(e) => cart.setQuantity(line.productId, Number(e.target.value.replace(/\D/g, '')) || 1)} />
                  <button type="button" onClick={() => cart.setQuantity(line.productId, line.quantity + 1)} aria-label="Increase"><Plus size={12} /></button>
                </div>
                <strong>{money(price(line) * line.quantity)}</strong>
                <button className="icon-button" onClick={() => cart.remove(line.productId)} aria-label={`Remove ${line.name}`}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>
        <aside className="dash-card summary-card">
          <h2>Summary</h2>
          <div className="summary-row"><span>Subtotal</span><strong>{money(subtotal)}</strong></div>
          {bulk.percent ? <div className="summary-row"><span>Bulk pricing</span><strong className="ok-text">{bulk.percent}% off reseller price</strong></div> : null}
          {bulk.next ? <small className="muted" data-testid="text-next-tier">Add {bulk.next.minBottles - cart.count} more bottles for {bulk.next.percent}% off.</small> : null}
          <div className="summary-row"><span>Delivery</span><strong>{shipping === 0 ? 'Free' : money(shipping)}</strong></div>
          {config.data && shipping > 0 ? <small className="muted">Free delivery on orders over {money(config.data.freeShippingThreshold)}.</small> : null}
          <div className="summary-row total"><span>Total</span><strong data-testid="text-cart-total">{money(subtotal + shipping)}</strong></div>
          {belowMinimum ? <p className="form-message" data-testid="state-minimum">{me?.reseller?.openingOrderCompleted ? `Reseller re-orders need at least ${minimum} bottles.` : `Your opening order needs at least ${minimum} bottles (mixed fragrances allowed). Add ${minimum - cart.count} more.`}</p> : null}
          {missingResellerPrice ? <p className="form-message">Some items were added before you signed in. Remove and re-add them to load reseller pricing.</p> : null}
          <Link className={`btn-primary block ${belowMinimum || missingResellerPrice ? 'disabled' : ''}`} href={belowMinimum || missingResellerPrice ? '/cart' : '/checkout'} data-testid="button-checkout">Checkout <ArrowRight size={15} /></Link>
          <Link className="btn-ghost block" href="/shop">Continue shopping</Link>
        </aside>
      </div>
    </main>
  );
}

export function CheckoutPage() {
  const cart = useCart();
  const config = useStoreConfig();
  const { data: me } = useMe();
  const [, navigate] = useLocation();
  const checkout = useCheckout();
  const referral = getReferral();
  const user = me?.user;
  const [form, setForm] = useState({
    firstName: '', surname: '', email: '', mobile: '',
    line1: '', line2: '', suburb: '', city: '', province: '', postalCode: '',
    notes: '', referralCode: referral?.code ?? '', paymentMethod: 'eft' as 'eft' | 'shopify', saveAddress: true,
  });
  useSeo({ title: 'Checkout', noindex: true });
  useEffect(() => { track('begin_checkout', { value: subtotal, items: cart.count }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!user) return;
    setForm((f) => ({
      ...f,
      firstName: f.firstName || user.firstName, surname: f.surname || user.surname, email: f.email || user.email, mobile: f.mobile || (user.mobile ?? ''),
      line1: f.line1 || (user.addressLine1 ?? ''), line2: f.line2 || (user.addressLine2 ?? ''), suburb: f.suburb || (user.suburb ?? ''), city: f.city || (user.city ?? ''), province: f.province || (user.province ?? ''), postalCode: f.postalCode || (user.postalCode ?? ''),
    }));
  }, [user]);

  if (!cart.lines.length && !checkout.isSuccess) return <main className="container-wide dashboard-wrap"><EmptyState title="Your bag is empty." /><p style={{ textAlign: 'center' }}><Link className="btn-primary" href="/shop">Shop</Link></p></main>;
  const set = (key: keyof typeof form, value: string | boolean) => setForm((f) => ({ ...f, [key]: value }));
  const { bulk, price, subtotal, shipping } = useTotals();
  const isResellerOrder = cart.mode === 'reseller';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: CheckoutInput = {
      mode: cart.mode,
      items: cart.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
      customer: { firstName: form.firstName, surname: form.surname, email: form.email, mobile: form.mobile },
      address: { line1: form.line1, line2: form.line2 || null, suburb: form.suburb || null, city: form.city, province: form.province, postalCode: form.postalCode },
      paymentMethod: form.paymentMethod,
      referralCode: isResellerOrder ? null : form.referralCode.trim() || null,
      attributionSource: form.referralCode && referral?.code === form.referralCode.trim().toUpperCase() ? referral.source : 'code',
      notes: form.notes || null,
      saveAddress: Boolean(me?.signedIn && form.saveAddress),
    };
    checkout.mutate({ data }, {
      onSuccess: (result) => {
        track('purchase', { transaction_id: result.order.orderNumber, value: result.order.total, shipping: result.order.shippingFee });
        cart.clear();
        if (result.order.referralCode) clearReferral();
        if (result.checkoutUrl) window.location.href = result.checkoutUrl;
        else navigate(`/order/${result.order.orderNumber}?email=${encodeURIComponent(result.order.customerEmail)}&new=1`);
      },
    });
  };

  return (
    <main className="container-wide dashboard-wrap">
      <div className="dashboard-top"><div><span className="eyebrow">{isResellerOrder ? 'Reseller stock order' : 'Checkout'}</span><h1 className="display-md">Delivery & payment</h1></div></div>
      <form className="checkout-grid" onSubmit={submit} data-testid="form-checkout">
        <section className="form-card">
          {!me?.signedIn ? <p className="notice">Have an account? <Link href="/sign-in?next=/checkout">Sign in</Link> to track orders and save your address.</p> : null}
          <h2>Contact</h2>
          <div className="form-grid">
            <Field id="firstName" label="First name" value={form.firstName} onChange={(v) => set('firstName', v)} required autoComplete="given-name" />
            <Field id="surname" label="Surname" value={form.surname} onChange={(v) => set('surname', v)} required autoComplete="family-name" />
            <Field id="email" label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} required autoComplete="email" />
            <Field id="mobile" label="Mobile number" type="tel" value={form.mobile} onChange={(v) => set('mobile', v)} required minLength={9} autoComplete="tel" />
          </div>
          <h2 className="mt">South African delivery address</h2>
          <div className="form-grid">
            <Field id="line1" label="Street address" value={form.line1} onChange={(v) => set('line1', v)} required full autoComplete="address-line1" />
            <Field id="line2" label="Complex / unit (optional)" value={form.line2} onChange={(v) => set('line2', v)} autoComplete="address-line2" />
            <Field id="suburb" label="Suburb" value={form.suburb} onChange={(v) => set('suburb', v)} />
            <Field id="city" label="City / town" value={form.city} onChange={(v) => set('city', v)} required autoComplete="address-level2" />
            <div className="field"><label htmlFor="province">Province</label><select id="province" required value={form.province} onChange={(e) => set('province', e.target.value)} data-testid="select-province"><option value="">Choose province</option>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</select></div>
            <Field id="postalCode" label="Postal code" value={form.postalCode} onChange={(v) => set('postalCode', v.replace(/\D/g, '').slice(0, 4))} required pattern="[0-9]{4}" inputMode="numeric" autoComplete="postal-code" />
            <Field id="notes" label="Delivery notes (optional)" value={form.notes} onChange={(v) => set('notes', v)} full />
          </div>
          {me?.signedIn ? <label className="check-row"><input type="checkbox" checked={form.saveAddress} onChange={(e) => set('saveAddress', e.target.checked)} /><span>Save this address to my account</span></label> : null}
          {!isResellerOrder ? (
            <>
              <h2 className="mt">Reseller referral</h2>
              <div className="form-grid"><Field id="referralCode" label="Reseller / referral code (optional)" value={form.referralCode} onChange={(v) => set('referralCode', v.toUpperCase())} full /></div>
              {referral?.name && form.referralCode === referral.code ? <small className="muted">Your purchase supports {referral.name}.</small> : null}
            </>
          ) : null}
          <h2 className="mt">Payment</h2>
          <div className="pay-options">
            <label className={`pay-option ${form.paymentMethod === 'eft' ? 'on' : ''}`}><input type="radio" name="pay" checked={form.paymentMethod === 'eft'} onChange={() => set('paymentMethod', 'eft')} /><span><strong>EFT / bank transfer</strong><small>Pay using your order number as the reference. We ship once payment reflects.</small></span></label>
            {config.data?.shopifyCheckoutEnabled && !isResellerOrder ? (
              <label className={`pay-option ${form.paymentMethod === 'shopify' ? 'on' : ''}`}><input type="radio" name="pay" checked={form.paymentMethod === 'shopify'} onChange={() => set('paymentMethod', 'shopify')} /><span><strong>Card, Instant EFT, SnapScan & more</strong><small>Secure Shopify checkout (PayFast / Yoco / Peach Payments).</small></span></label>
            ) : null}
          </div>
          {checkout.error ? <div className="form-message" data-testid="state-checkout-error">{errorMessage(checkout.error, 'We could not place your order. Please check your details.')}</div> : null}
        </section>
        <aside className="dash-card summary-card">
          <h2>Order summary</h2>
          {cart.lines.map((l) => <div key={l.productId} className="summary-row"><span>{l.quantity} × {l.name} {l.size}</span><span>{money(price(l) * l.quantity)}</span></div>)}
          {bulk.percent ? <div className="summary-row"><span>Bulk pricing</span><strong className="ok-text">{bulk.percent}% off</strong></div> : null}
          <div className="summary-row"><span>Delivery</span><strong>{shipping === 0 ? 'Free' : money(shipping)}</strong></div>
          <div className="summary-row total"><span>Total (ZAR, incl. VAT)</span><strong>{money(subtotal + shipping)}</strong></div>
          <small className="muted">By placing this order you agree to our <Link href="/terms">terms</Link>{isResellerOrder ? <> and <Link href="/reseller-terms">reseller terms</Link></> : null}.</small>
          <button className="btn-primary block" type="submit" disabled={checkout.isPending} data-testid="button-place-order">{checkout.isPending ? 'Placing order…' : 'Place order'} <ArrowRight size={15} /></button>
        </aside>
      </form>
    </main>
  );
}

function Field({ id, label, value, onChange, full, ...rest }: { id: string; label: string; value: string; onChange: (v: string) => void; full?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={`input-${id}`} {...rest} />
    </div>
  );
}
