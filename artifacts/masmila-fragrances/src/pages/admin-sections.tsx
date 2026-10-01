import { type FormEvent, Fragment, useEffect, useMemo, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Download, Megaphone, Plus, Search, Upload } from 'lucide-react';
import {
  customFetch,
  getGetAdminReportQueryKey,
  getGetAdminSettingsQueryKey,
  getGetAdminSummaryQueryKey,
  getGetHomeSummaryQueryKey,
  getGetQualificationQueryKey,
  getGetStoreConfigQueryKey,
  getListAdminApplicationsQueryKey,
  getListAdminCommissionsQueryKey,
  getListAdminCustomersQueryKey,
  getListAdminEnquiriesQueryKey,
  getListAdminMarketingMaterialsQueryKey,
  getListAdminOrdersQueryKey,
  getListAdminPayoutsQueryKey,
  getListAdminProductsQueryKey,
  getListAdminResellersQueryKey,
  getListAdminTeamsQueryKey,
  getListAuditLogsQueryKey,
  getListFraudFlagsQueryKey,
  useApproveCommissions,
  useCreateAdminProduct,
  useCreateMarketingMaterial,
  useCreatePayouts,
  useDecideApplication,
  useDeleteMarketingMaterial,
  useGetAdminReport,
  useGetAdminSettings,
  useGetHomeSummary,
  useGetQualification,
  useListAdminApplications,
  useListAdminCommissions,
  useListAdminCustomers,
  useListAdminEnquiries,
  useListAdminMarketingMaterials,
  useListAdminOrders,
  useListAdminPayouts,
  useListAdminProducts,
  useListAdminResellers,
  useListAdminTeams,
  useListAuditLogs,
  useListFraudFlags,
  useSendAnnouncement,
  useUpdateMarketingMaterial,
  useUploadFile,
  useRefundAdminOrder,
  useRunQualification,
  useUpdateAdminCustomer,
  useUpdateAdminEnquiry,
  useUpdateAdminOrder,
  useUpdateAdminProduct,
  useUpdateAdminReseller,
  useUpdateAdminSettings,
  useUpdateFraudFlag,
  useUpdateSiteContent,
  type AdminProduct,
  type AnnouncementInput,
  type MarketingMaterial,
  type AdminSettings,
  type AdminSettingsInput,
  type Order,
  type ProductInput,
  type RefundInput,
  type ReportType,
} from '@workspace/api-client-react';
import { EmptyState, ErrorState, LoadingBlock, StatusPill } from '@/components/bits';
import { toast } from '@/hooks/use-toast';
import { currentPeriod, dateOnly, dateTime, errorMessage, humanise, money, periodLabel, rankLabel, shiftPeriod } from '@/lib/format';

function useInvalidate() {
  const queryClient = useQueryClient();
  return (...keys: QueryKey[]) => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: getGetAdminSummaryQueryKey() });
  };
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <label className="search-box admin-search"><Search size={15} /><input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} /></label>;
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function MutationError({ error }: { error: unknown }) {
  return error ? <div className="form-message">{errorMessage(error)}</div> : null;
}

// ------------------------------------------------------------------ applications

export function ApplicationsSection() {
  const [status, setStatus] = useState('pending');
  const params = status ? { status } : {};
  const apps = useListAdminApplications(params, { query: { queryKey: getListAdminApplicationsQueryKey(params) } });
  const decide = useDecideApplication({ mutation: { meta: { success: 'Application updated' } } });
  const invalidate = useInvalidate();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const act = (id: number, decision: 'approve' | 'reject' | 'request_info') =>
    decide.mutate({ id, data: { decision, note: notes[id] || null } }, { onSuccess: () => invalidate(getListAdminApplicationsQueryKey(), getListAdminResellersQueryKey()) });
  return (
    <section>
      <div className="toolbar">
        <h2>Reseller approval queue</h2>
        <select className="select-plain" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter applications">
          <option value="pending">Pending</option><option value="info_requested">More info requested</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option>
        </select>
      </div>
      <MutationError error={decide.error} />
      {apps.isLoading ? <LoadingBlock /> : apps.error ? <ErrorState error={apps.error} /> : !apps.data?.length ? <EmptyState title="Nothing in the queue." /> : (
        <div className="card-list">
          {apps.data.map((a) => (
            <article className="dash-card" key={a.id} data-testid={`application-${a.applicationId}`}>
              <div className="order-head"><div><span className="eyebrow">{a.applicationId} · {dateTime(a.createdAt)}</span><h3>{a.name}</h3></div><StatusPill status={a.status} /></div>
              <div className="kv-grid">
                <div className="kv"><span>Email</span><strong>{a.email}</strong></div><div className="kv"><span>Mobile</span><strong>{a.mobile}</strong></div>
                <div className="kv"><span>Location</span><strong>{a.city}, {a.province}</strong></div><div className="kv"><span>Contact via</span><strong>{a.contactMethod}</strong></div>
                <div className="kv"><span>Heard about us</span><strong>{a.heardAbout}</strong></div><div className="kv"><span>Referred by</span><strong>{a.sponsorName ?? '—'}</strong></div>
              </div>
              {a.warnings.length ? <div className="alert">{a.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div> : null}
              {a.adminNote ? <p className="muted">Note: {a.adminNote}</p> : null}
              {a.status !== 'approved' && a.status !== 'rejected' ? (
                <div className="action-row">
                  <input className="input-plain" placeholder="Note to applicant (optional)" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                  <button className="btn-primary small" disabled={decide.isPending} onClick={() => act(a.id, 'approve')} data-testid={`button-approve-${a.applicationId}`}>Approve</button>
                  <button className="btn-ghost small" disabled={decide.isPending} onClick={() => act(a.id, 'request_info')}>Request info</button>
                  <button className="btn-ghost small danger" disabled={decide.isPending} onClick={() => act(a.id, 'reject')}>Reject</button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ orders

function OrderAdmin({ order }: { order: Order }) {
  const update = useUpdateAdminOrder({ mutation: { meta: { success: 'Order updated' } } });
  const refund = useRefundAdminOrder({ mutation: { meta: { success: 'Refund processed' } } });
  const invalidate = useInvalidate();
  const [courier, setCourier] = useState(order.courier ?? 'The Courier Guy');
  const [tracking, setTracking] = useState(order.trackingNumber ?? '');
  const [attribution, setAttribution] = useState(order.referralCode ?? '');
  const [refundForm, setRefundForm] = useState<{ type: RefundInput['type']; reason: string; qty: Record<number, number> }>({ type: 'refund', reason: '', qty: {} });
  const done = { onSuccess: () => invalidate(getListAdminOrdersQueryKey(), getListAdminCommissionsQueryKey(), getListAdminProductsQueryKey()) };
  const paid = ['paid', 'processing', 'shipped', 'delivered', 'partially_refunded'].includes(order.status);
  const submitRefund = (e: FormEvent) => {
    e.preventDefault();
    const items = Object.entries(refundForm.qty).filter(([, q]) => q > 0).map(([id, q]) => ({ orderItemId: Number(id), quantity: q }));
    refund.mutate({ id: order.id, data: { type: refundForm.type, reason: refundForm.reason, ...(items.length ? { items } : {}) } }, done);
  };
  return (
    <div className="order-admin">
      <div className="kv-grid">
        <div className="kv"><span>Customer</span><strong>{order.customerName}</strong><small>{order.customerEmail} · {order.customerMobile}</small></div>
        <div className="kv"><span>Deliver to</span><strong>{order.shippingAddress}</strong></div>
        <div className="kv"><span>Payment</span><strong>{humanise(order.paymentMethod)}{order.paymentReference ? ` · ${order.paymentReference}` : ''}</strong></div>
        <div className="kv"><span>Attribution</span><strong>{order.attributedReseller ?? (order.buyerResellerCode ? `Reseller order · ${order.buyerResellerCode}` : '—')}</strong><small>{order.attributionSource ?? ''}</small></div>
        <div className="kv"><span>Wholesale / cost / GP</span><strong>{money(order.wholesaleValue)} / {money(order.costValue)} / {money(order.grossProfit)}</strong></div>
        <div className="kv"><span>Incentives on order</span><strong>{money(order.incentiveTotal)}</strong></div>
      </div>
      <table className="table compact"><tbody>{order.items.map((i) => <tr key={i.id}><td>{i.quantity} × {i.name} {i.size} <small>{i.sku}</small>{i.refundedQuantity ? <small> · {i.refundedQuantity} refunded</small> : null}</td><td className="num">{money(i.lineTotal)}</td></tr>)}</tbody></table>
      {order.notes ? <p className="muted">Notes: {order.notes}</p> : null}
      <div className="action-row">
        {order.status === 'awaiting_payment' ? <button className="btn-primary small" onClick={() => update.mutate({ id: order.id, data: { status: 'paid' } }, done)} data-testid="button-mark-paid">Mark paid</button> : null}
        {paid && order.status !== 'processing' && !order.shippedAt ? <button className="btn-ghost small" onClick={() => update.mutate({ id: order.id, data: { status: 'processing' } }, done)}>Processing</button> : null}
        {paid ? (
          <>
            <select className="select-plain" value={courier} onChange={(e) => setCourier(e.target.value)} aria-label="Courier"><option>The Courier Guy</option><option>Bob Go</option><option>Pargo</option><option>Aramex</option><option>PostNet</option><option>Fastway / Aramex</option><option>Own delivery</option></select>
            <input className="input-plain" placeholder="Tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            <button className="btn-ghost small" onClick={() => update.mutate({ id: order.id, data: { status: 'shipped', courier, trackingNumber: tracking || null } }, done)}>Mark shipped</button>
            <button className="btn-ghost small" onClick={() => update.mutate({ id: order.id, data: { status: 'delivered' } }, done)}>Mark delivered</button>
          </>
        ) : null}
      </div>
      {order.channel === 'retail' ? (
        <div className="action-row">
          <input className="input-plain" placeholder="Referral code for manual attribution" value={attribution} onChange={(e) => setAttribution(e.target.value.toUpperCase())} />
          <button className="btn-ghost small" onClick={() => update.mutate({ id: order.id, data: { attributedReferralCode: attribution || null } }, done)}>Save attribution</button>
        </div>
      ) : null}
      <MutationError error={update.error} />
      {order.status !== 'cancelled' && order.status !== 'refunded' ? (
        <form className="refund-form" onSubmit={submitRefund}>
          <strong>{order.status === 'awaiting_payment' ? 'Cancel order' : 'Refund / cancel / return / chargeback'}</strong>
          {order.status !== 'awaiting_payment' ? (
            <div className="action-row">
              <select className="select-plain" value={refundForm.type} onChange={(e) => setRefundForm({ ...refundForm, type: e.target.value as RefundInput['type'] })}><option value="refund">Refund</option><option value="cancel">Cancel</option><option value="return">Return (restock)</option><option value="chargeback">Chargeback</option></select>
              {order.items.map((i) => <label key={i.id} className="mini-qty">{i.name} {i.size}<input type="number" min={0} max={i.quantity - i.refundedQuantity} value={refundForm.qty[i.id] ?? 0} onChange={(e) => setRefundForm({ ...refundForm, qty: { ...refundForm.qty, [i.id]: Number(e.target.value) } })} /></label>)}
            </div>
          ) : null}
          <div className="action-row">
            <input className="input-plain" required minLength={2} placeholder="Reason (recorded in the audit trail)" value={refundForm.reason} onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })} />
            <button className="btn-ghost small danger" type="submit" disabled={refund.isPending} data-testid="button-refund">{order.status === 'awaiting_payment' ? 'Cancel order' : 'Process'}</button>
          </div>
          <small className="muted">Leave quantities at 0 to apply to the whole order. Associated incentives are reversed automatically.</small>
          <MutationError error={refund.error} />
        </form>
      ) : null}
    </div>
  );
}

export function OrdersSection() {
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const params = { ...(status ? { status } : {}), ...(channel ? { channel } : {}), ...(q ? { search: q } : {}) };
  const orders = useListAdminOrders(params, { query: { queryKey: getListAdminOrdersQueryKey(params) } });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section>
      <div className="toolbar">
        <h2>Orders</h2>
        <SearchBox value={search} onChange={setSearch} placeholder="Order number, name or email" />
        <select className="select-plain" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All statuses</option>{['awaiting_payment', 'paid', 'processing', 'shipped', 'delivered', 'partially_refunded', 'refunded', 'cancelled'].map((s) => <option key={s} value={s}>{humanise(s)}</option>)}</select>
        <select className="select-plain" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel"><option value="">Retail & reseller</option><option value="retail">Retail</option><option value="reseller">Reseller</option></select>
      </div>
      {orders.isLoading ? <LoadingBlock /> : orders.error ? <ErrorState error={orders.error} /> : !orders.data?.length ? <EmptyState title="No orders match." /> : (
        <div className="table-wrap"><table className="table" data-testid="table-orders">
          <thead><tr><th>Order</th><th>Customer</th><th>Channel</th><th>Status</th><th className="num">Bottles</th><th className="num">Total</th><th /></tr></thead>
          <tbody>{orders.data.map((o) => (
            <Fragment key={o.id}>
              <tr className="clickable" onClick={() => setOpen(open === o.id ? null : o.id)}>
                <td><strong>{o.orderNumber}</strong><small>{dateTime(o.createdAt)}</small></td>
                <td>{o.customerName}<small>{o.attributedReseller ? `via ${o.attributedReseller}` : o.customerEmail}</small></td>
                <td>{humanise(o.channel)}</td><td><StatusPill status={o.status} /></td><td className="num">{o.bottles}</td><td className="num">{money(o.total)}</td>
                <td>{open === o.id ? '▲' : '▼'}</td>
              </tr>
              {open === o.id ? <tr className="detail-row"><td colSpan={7}><OrderAdmin order={o} /></td></tr> : null}
            </Fragment>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ products

const EMPTY_PRODUCT: ProductInput = { sku: '', name: '', category: "Women's", family: 'Floral', size: '50ml', retailPrice: 299, recommendedRetailPrice: 299, resellerPrice: 140, cost: 70, stockQuantity: 0, lowStockThreshold: 10, description: '', scentProfile: '', topNotes: [], middleNotes: [], baseNotes: [], image: '', imageAlt: '', keywords: '', status: 'active', isBestSeller: false, isNew: true, isFeatured: false, shopifyVariantId: null };

function ProductEditor({ initial, onSave, pending, error, submitLabel }: { initial: ProductInput; onSave: (p: ProductInput) => void; pending: boolean; error: unknown; submitLabel: string }) {
  const [p, setP] = useState<ProductInput>(initial);
  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setP((c) => ({ ...c, [k]: v }));
  const notes = (k: 'topNotes' | 'middleNotes' | 'baseNotes') => (p[k] ?? []).join(', ');
  const text = (k: keyof ProductInput, label: string, full = false) => <div className={`field ${full ? 'full' : ''}`}><label>{label}</label><input value={String(p[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} /></div>;
  const num = (k: keyof ProductInput, label: string) => <div className="field"><label>{label}</label><input type="number" min={0} step="0.01" value={Number(p[k] ?? 0)} onChange={(e) => set(k, Number(e.target.value) as never)} /></div>;
  return (
    <form className="product-editor" onSubmit={(e) => { e.preventDefault(); onSave(p); }}>
      <div className="form-grid three">
        {text('name', 'Product name')}{text('sku', 'Mas\'Mila SKU')}
        <div className="field"><label>Size</label><select value={p.size} onChange={(e) => set('size', e.target.value as ProductInput['size'])}><option>50ml</option><option>100ml</option></select></div>
        <div className="field"><label>Category</label><select value={p.category} onChange={(e) => set('category', e.target.value)}><option>Women's</option><option>Men's</option><option>Unisex</option></select></div>
        <div className="field"><label>Fragrance family</label><select value={p.family} onChange={(e) => set('family', e.target.value)}>{['Floral', 'Fresh', 'Fruity', 'Woody', 'Oriental', 'Sweet', 'Citrus'].map((f) => <option key={f}>{f}</option>)}</select></div>
        <div className="field"><label>Status</label><select value={p.status} onChange={(e) => set('status', e.target.value as ProductInput['status'])}><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
        {num('retailPrice', 'Retail price (R)')}{num('recommendedRetailPrice', 'Recommended retail (R)')}{num('resellerPrice', 'Reseller price (R) — private')}{num('cost', 'Internal cost (R) — private')}
        {num('stockQuantity', 'Stock quantity')}{num('lowStockThreshold', 'Low-stock level')}
        {text('scentProfile', 'Scent profile', true)}
        <div className="field full"><label>Description</label><textarea rows={3} value={p.description ?? ''} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="field"><label>Top notes (comma separated)</label><input value={notes('topNotes')} onChange={(e) => set('topNotes', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></div>
        <div className="field"><label>Middle notes</label><input value={notes('middleNotes')} onChange={(e) => set('middleNotes', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></div>
        <div className="field"><label>Base notes</label><input value={notes('baseNotes')} onChange={(e) => set('baseNotes', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></div>
        <div className="field full"><label>Product image</label><div className="inline-edit grow"><input value={String(p.image ?? '')} onChange={(e) => set('image', e.target.value)} placeholder="https://… or upload" /><FileUploadButton accept="image/*" label="Upload image" onUploaded={(url) => set('image', url)} /></div></div>{text('imageAlt', 'Image alt text', true)}{text('keywords', 'Search keywords', true)}
        <div className="field"><label>Shopify variant ID</label><input value={p.shopifyVariantId ?? ''} onChange={(e) => set('shopifyVariantId', e.target.value || null)} placeholder="gid://shopify/ProductVariant/…" /></div>
      </div>
      <div className="action-row">
        <label className="check-row"><input type="checkbox" checked={Boolean(p.isBestSeller)} onChange={(e) => set('isBestSeller', e.target.checked)} /> Best seller</label>
        <label className="check-row"><input type="checkbox" checked={Boolean(p.isNew)} onChange={(e) => set('isNew', e.target.checked)} /> New arrival</label>
        <label className="check-row"><input type="checkbox" checked={Boolean(p.isFeatured)} onChange={(e) => set('isFeatured', e.target.checked)} /> Featured</label>
        <button className="btn-primary small" type="submit" disabled={pending}>{pending ? 'Saving…' : submitLabel}</button>
      </div>
      <MutationError error={error} />
    </form>
  );
}

export function ProductsSection() {
  const products = useListAdminProducts({ query: { queryKey: getListAdminProductsQueryKey() } });
  const create = useCreateAdminProduct({ mutation: { meta: { success: 'Product created' } } });
  const update = useUpdateAdminProduct({ mutation: { meta: { success: 'Product saved' } } });
  const invalidate = useInvalidate();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const rows = useMemo(() => (products.data ?? []).filter((p) => (!lowOnly || p.available <= p.lowStockThreshold) && `${p.name} ${p.sku} ${p.family}`.toLowerCase().includes(search.toLowerCase())), [products.data, search, lowOnly]);
  const toInput = (p: AdminProduct): ProductInput => ({ ...p, size: p.size as ProductInput['size'], status: p.status as ProductInput['status'] });
  const done = { onSuccess: () => { setEditing(null); invalidate(getListAdminProductsQueryKey(), getGetHomeSummaryQueryKey()); } };
  return (
    <section>
      <div className="toolbar">
        <h2>Products, prices & inventory</h2>
        <SearchBox value={search} onChange={setSearch} placeholder="Search name, SKU, family" />
        <label className="check-row"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock only</label>
        <button className="btn-primary small" onClick={() => setEditing(editing === 'new' ? null : 'new')} data-testid="button-new-product"><Plus size={14} /> New product</button>
      </div>
      {editing === 'new' ? <div className="dash-card"><h3>New product</h3><ProductEditor initial={EMPTY_PRODUCT} submitLabel="Create product" pending={create.isPending} error={create.error} onSave={(p) => create.mutate({ data: p }, done)} /></div> : null}
      {products.isLoading ? <LoadingBlock /> : products.error ? <ErrorState error={products.error} /> : (
        <div className="table-wrap"><table className="table" data-testid="table-products">
          <thead><tr><th>Product</th><th>Status</th><th className="num">Retail</th><th className="num">Reseller</th><th className="num">Cost</th><th className="num">Stock</th><th className="num">Reserved</th><th className="num">Sold</th><th className="num">Available</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <Fragment key={p.id}>
              <tr className={p.available <= p.lowStockThreshold ? 'warn-row' : ''}>
                <td><strong>{p.name} {p.size}</strong><small>{p.sku} · {p.category} · {p.family}</small></td>
                <td><StatusPill status={p.status === 'active' ? 'active' : 'inactive'} label={humanise(p.status)} /></td>
                <td className="num">{money(p.retailPrice)}</td><td className="num">{money(p.resellerPrice)}</td><td className="num">{money(p.cost)}</td>
                <td className="num">{p.stockQuantity}</td><td className="num">{p.reservedQuantity}</td><td className="num">{p.soldQuantity}</td>
                <td className="num">{p.available <= p.lowStockThreshold ? <strong className="bad-text">{p.available} LOW</strong> : p.available}</td>
                <td><button className="btn-ghost small" onClick={() => setEditing(editing === p.id ? null : p.id)}>{editing === p.id ? 'Close' : 'Edit'}</button></td>
              </tr>
              {editing === p.id ? <tr className="detail-row"><td colSpan={10}><ProductEditor initial={toInput(p)} submitLabel="Save changes" pending={update.isPending} error={update.error} onSave={(input) => { const { slug: _slug, ...rest } = input; void _slug; update.mutate({ id: p.id, data: rest }, done); }} /></td></tr> : null}
            </Fragment>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ resellers & teams

export function ResellersSection() {
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const params = q ? { search: q } : {};
  const resellers = useListAdminResellers(params, { query: { queryKey: getListAdminResellersQueryKey(params) } });
  const update = useUpdateAdminReseller({ mutation: { meta: { success: 'Reseller updated' } } });
  const invalidate = useInvalidate();
  const [sponsorEdits, setSponsorEdits] = useState<Record<number, string>>({});
  const done = { onSuccess: () => invalidate(getListAdminResellersQueryKey(), getListAdminTeamsQueryKey()) };
  return (
    <section>
      <div className="toolbar"><h2>Resellers</h2><SearchBox value={search} onChange={setSearch} placeholder="Name, email, reseller ID or referral code" /></div>
      <MutationError error={update.error} />
      {resellers.isLoading ? <LoadingBlock /> : resellers.error ? <ErrorState error={resellers.error} /> : !resellers.data?.length ? <EmptyState title="No resellers yet." /> : (
        <div className="table-wrap"><table className="table" data-testid="table-resellers">
          <thead><tr><th>Reseller</th><th>Rank</th><th>Status</th><th>Standing</th><th>Sponsor</th><th className="num">Bottles (mo)</th><th className="num">Team</th><th>Last order</th></tr></thead>
          <tbody>{resellers.data.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.name}</strong><small>{r.resellerCode} · {r.referralCode} · {r.email}</small>{!r.openingOrderCompleted ? <small className="bad-text">Opening order outstanding</small> : null}</td>
              <td>
                <select className="select-plain" value={r.rank} onChange={(e) => update.mutate({ id: r.id, data: { rank: e.target.value as 'reseller' } }, done)} aria-label={`Rank for ${r.name}`}>{['reseller', 'team_leader', 'manager', 'director'].map((k) => <option key={k} value={k}>{rankLabel(k)}</option>)}</select>
                <label className="check-row tiny"><input type="checkbox" checked={r.rankLocked} onChange={(e) => update.mutate({ id: r.id, data: { rankLocked: e.target.checked } }, done)} /> lock rank</label>
              </td>
              <td><StatusPill status={r.status} /></td>
              <td><select className="select-plain" value={r.standing} onChange={(e) => update.mutate({ id: r.id, data: { standing: e.target.value as 'good' } }, done)} aria-label={`Standing for ${r.name}`} data-testid={`select-standing-${r.resellerCode}`}><option value="good">Good</option><option value="review">Review</option><option value="hold">Hold</option><option value="suspended">Suspended</option></select></td>
              <td>
                <div className="inline-edit"><input className="input-plain" placeholder="Sponsor code" value={sponsorEdits[r.id] ?? r.sponsorCode ?? ''} onChange={(e) => setSponsorEdits({ ...sponsorEdits, [r.id]: e.target.value.toUpperCase() })} />
                  {sponsorEdits[r.id] !== undefined && sponsorEdits[r.id] !== (r.sponsorCode ?? '') ? <button className="btn-ghost small" onClick={() => update.mutate({ id: r.id, data: { sponsorCode: sponsorEdits[r.id] || null } }, done)}>Save</button> : null}
                </div><small>{r.sponsor ?? 'No sponsor'}</small>
              </td>
              <td className="num">{r.personalBottles}</td><td className="num">{r.teamBottles}<small>{r.directs} directs</small></td><td>{dateOnly(r.lastOrderAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function TeamsSection() {
  const teams = useListAdminTeams({ query: { queryKey: getListAdminTeamsQueryKey() } });
  if (teams.isLoading) return <LoadingBlock />;
  if (teams.error) return <ErrorState error={teams.error} />;
  if (!teams.data?.length) return <EmptyState title="No resellers yet." />;
  return (
    <section className="dash-card">
      <h2>Team hierarchy · {periodLabel(currentPeriod())}</h2>
      <p className="muted small-text">Mas'Mila → Manager → Team Leader → Reseller. Bottles are qualifying volume this month.</p>
      <div className="tree" data-testid="team-tree">
        {teams.data.map((n) => (
          <div key={n.id} className={`tree-node rank-${n.rank} ${n.status}`} style={{ paddingLeft: 12 + n.depth * 22 }}>
            <span><strong>{n.name}</strong> <small>{n.resellerCode}</small> <StatusPill status={n.rank} label={rankLabel(n.rank)} /> <StatusPill status={n.status} />{n.standing !== 'good' ? <StatusPill status={n.standing} /> : null}</span>
            <span className="tree-stats">{n.personalBottles} own · {n.teamBottles} team · {n.orgBottles} org · {n.directs} directs</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ incentives

export function IncentivesSection() {
  const [period, setPeriod] = useState(shiftPeriod(currentPeriod(), -1));
  const [status, setStatus] = useState('pending');
  const qParams = { period };
  const qualification = useGetQualification(qParams, { query: { queryKey: getGetQualificationQueryKey(qParams) } });
  const run = useRunQualification({ mutation: { meta: { success: 'Qualification run complete' } } });
  const lParams = { ...(status ? { status } : {}), ...(period ? { period } : {}) };
  const ledger = useListAdminCommissions(lParams, { query: { queryKey: getListAdminCommissionsQueryKey(lParams) } });
  const payouts = useListAdminPayouts({ query: { queryKey: getListAdminPayoutsQueryKey() } });
  const approve = useApproveCommissions({ mutation: { meta: { success: 'Incentives approved' } } });
  const pay = useCreatePayouts({ mutation: { meta: { success: 'Payouts recorded' } } });
  const invalidate = useInvalidate();
  const [selected, setSelected] = useState<number[]>([]);
  const [reference, setReference] = useState('');
  const periods = Array.from({ length: 12 }, (_, i) => shiftPeriod(currentPeriod(), -i));
  const approvable = (ledger.data ?? []).filter((r) => r.status === 'pending' && (r.qualificationStatus === 'qualified' || r.entryType === 'reversal'));
  const refresh = () => invalidate(getListAdminCommissionsQueryKey(), getGetQualificationQueryKey(), getListAdminPayoutsQueryKey(), getListAdminResellersQueryKey());
  const q = qualification.data;
  return (
    <section>
      <div className="toolbar">
        <h2>Qualification & incentives</h2>
        <select className="select-plain" value={period} onChange={(e) => { setPeriod(e.target.value); setSelected([]); }} aria-label="Period">{periods.map((p) => <option key={p} value={p}>{periodLabel(p)}{p === currentPeriod() ? ' (current)' : ''}</option>)}</select>
      </div>
      <div className="dash-card">
        <div className="order-head"><div><span className="eyebrow">Month-end run · {periodLabel(period)}</span><h3>{q?.status === 'closed' ? `Run ${dateTime(q.runAt)}` : 'Preview — not yet run'}</h3></div>
          <button className="btn-primary small" disabled={run.isPending} onClick={() => run.mutate({ data: { period } }, { onSuccess: refresh })} data-testid="button-run-qualification">{run.isPending ? 'Running…' : q?.status === 'closed' ? 'Re-run qualification' : 'Run qualification'}</button></div>
        <p className="muted small-text">Calculates personal, team and organisation volume, active status, rank promotions, coaching warnings and reversions, then confirms or voids that month's incentives. Safe to re-run.</p>
        <MutationError error={run.error} />
        {q ? (
          <>
            <div className="metric-grid five compact">
              <div className="mini-stat"><strong>{q.activeResellers}</strong><span>active</span></div><div className="mini-stat"><strong>{q.promotions}</strong><span>promotions</span></div>
              <div className="mini-stat"><strong>{q.warnings}</strong><span>warnings</span></div><div className="mini-stat"><strong>{q.demotions}</strong><span>reversions</span></div>
              <div className="mini-stat"><strong>{q.ledgerQualified}/{q.ledgerVoided}</strong><span>qualified / void</span></div>
            </div>
            <details><summary>Qualification detail ({q.rows.length} resellers)</summary>
              <div className="table-wrap"><table className="table compact">
                <thead><tr><th>Reseller</th><th className="num">Own</th><th className="num">Team</th><th className="num">Org</th><th className="num">Active directs</th><th className="num">TLs</th><th>Active</th><th>Qualifies</th><th>Rank</th></tr></thead>
                <tbody>{q.rows.map((r) => <tr key={r.resellerId}><td>{r.name}<small>{r.resellerCode}</small></td><td className="num">{r.personalBottles}</td><td className="num">{r.teamBottles}</td><td className="num">{r.orgBottles}</td><td className="num">{r.activeDirects}</td><td className="num">{r.activeTeamLeaders}</td><td>{r.isActive ? 'Yes' : 'No'}</td><td>{rankLabel(r.qualifiedRank)}</td><td>{rankLabel(r.rankBefore)}{r.rankAfter !== r.rankBefore ? ` → ${rankLabel(r.rankAfter)}` : ''}{r.warning ? ' ⚠ coaching' : ''}</td></tr>)}</tbody>
              </table></div>
            </details>
          </>
        ) : qualification.isLoading ? <LoadingBlock /> : null}
      </div>

      <div className="toolbar mt">
        <h3>Commission ledger</h3>
        <select className="select-plain" value={status} onChange={(e) => { setStatus(e.target.value); setSelected([]); }} aria-label="Ledger status"><option value="">All</option>{['pending', 'approved', 'paid', 'reversed', 'void'].map((s) => <option key={s} value={s}>{humanise(s)}</option>)}</select>
        {approvable.length ? <button className="btn-ghost small" onClick={() => setSelected(selected.length ? [] : approvable.map((r) => r.id))}>{selected.length ? 'Clear selection' : `Select ${approvable.length} approvable`}</button> : null}
        <button className="btn-primary small" disabled={!selected.length || approve.isPending} onClick={() => approve.mutate({ data: { ids: selected } }, { onSuccess: () => { setSelected([]); refresh(); } })} data-testid="button-approve-commissions">Approve {selected.length || ''}</button>
      </div>
      <MutationError error={approve.error} />
      {ledger.isLoading ? <LoadingBlock /> : !ledger.data?.length ? <EmptyState title="No ledger entries for this filter." /> : (
        <div className="table-wrap"><table className="table compact" data-testid="table-ledger">
          <thead><tr><th /><th>Order</th><th>Seller → beneficiary</th><th>Type</th><th className="num">Qty</th><th className="num">Wholesale</th><th className="num">Rate</th><th className="num">Incentive</th><th>Qualification</th><th>Status</th></tr></thead>
          <tbody>{ledger.data.map((r) => {
            const can = r.status === 'pending' && (r.qualificationStatus === 'qualified' || r.entryType === 'reversal');
            return (
              <tr key={r.id} className={r.status === 'void' || r.status === 'reversed' ? 'dim' : ''}>
                <td>{can ? <input type="checkbox" checked={selected.includes(r.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} aria-label={`Select entry ${r.id}`} /> : null}</td>
                <td>{r.orderNumber}<small>{r.productName} · {r.period}</small></td>
                <td>{r.seller} → <strong>{r.beneficiary}</strong><small>{r.beneficiaryResellerCode} · {rankLabel(r.beneficiaryRank)}</small></td>
                <td>{r.entryType === 'reversal' ? 'Reversal' : rankLabel(r.kind)}</td><td className="num">{r.quantity}</td><td className="num">{money(r.baseValue)}</td><td className="num">{r.rate}%</td><td className="num"><strong>{money(r.amount)}</strong></td>
                <td><StatusPill status={r.qualificationStatus} /></td><td><StatusPill status={r.status} />{r.note ? <small>{r.note}</small> : null}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}

      <div className="toolbar mt">
        <h3>Payouts</h3>
        <input className="input-plain" placeholder="Payment reference (e.g. EFT batch)" value={reference} onChange={(e) => setReference(e.target.value)} />
        <button className="btn-primary small" disabled={pay.isPending} onClick={() => pay.mutate({ data: { reference: reference || null } }, { onSuccess: refresh })} data-testid="button-create-payouts">Pay all approved</button>
      </div>
      {pay.data ? <p className="ok-text">{pay.data.length ? `${pay.data.length} payout(s) recorded.` : 'Nothing approved to pay.'}</p> : null}
      <MutationError error={pay.error} />
      {payouts.data?.length ? (
        <div className="table-wrap"><table className="table compact"><thead><tr><th>Payout</th><th>Reseller</th><th className="num">Entries</th><th className="num">Amount</th><th>Reference</th><th>Date</th></tr></thead>
          <tbody>{payouts.data.map((p) => <tr key={p.id}><td>{p.payoutNumber}</td><td>{p.resellerName}<small>{p.resellerCode}</small></td><td className="num">{p.entryCount}</td><td className="num">{money(p.amount)}</td><td>{p.reference ?? '—'}</td><td>{dateTime(p.createdAt)}</td></tr>)}</tbody></table></div>
      ) : <p className="muted">No payouts recorded yet.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ customers, enquiries, fraud

export function CustomersSection() {
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const params = q ? { search: q } : {};
  const customers = useListAdminCustomers(params, { query: { queryKey: getListAdminCustomersQueryKey(params) } });
  const update = useUpdateAdminCustomer({ mutation: { meta: { success: 'Account updated' } } });
  const invalidate = useInvalidate();
  return (
    <section>
      <div className="toolbar"><h2>Customers & accounts</h2><SearchBox value={search} onChange={setSearch} placeholder="Name, email or mobile" /></div>
      <MutationError error={update.error} />
      {customers.isLoading ? <LoadingBlock /> : !customers.data?.length ? <EmptyState title="No accounts found." /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Account</th><th>Role</th><th>Account status</th><th className="num">Orders</th><th className="num">Spent</th><th>Joined</th></tr></thead>
          <tbody>{customers.data.map((c) => (
            <tr key={c.id}>
              <td><strong>{c.name}</strong><small>{c.email}{c.mobile ? ` · ${c.mobile}` : ''}</small>{c.duplicateOf ? <small className="bad-text">⚠ Same mobile as {c.duplicateOf}</small> : null}</td>
              <td><select className="select-plain" value={c.role} onChange={(e) => update.mutate({ id: c.id, data: { role: e.target.value as 'customer' } }, { onSuccess: () => invalidate(getListAdminCustomersQueryKey()) })}><option value="customer">Customer</option><option value="reseller">Reseller</option><option value="admin">Admin</option></select></td>
              <td><select className="select-plain" value={c.accountStatus} onChange={(e) => update.mutate({ id: c.id, data: { accountStatus: e.target.value as 'active' } }, { onSuccess: () => invalidate(getListAdminCustomersQueryKey()) })}><option value="active">Active</option><option value="review">Review</option><option value="hold">Hold</option><option value="suspended">Suspended</option></select></td>
              <td className="num">{c.orders}</td><td className="num">{money(c.totalSpent)}</td><td>{dateOnly(c.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function EnquiriesSection() {
  const enquiries = useListAdminEnquiries({ query: { queryKey: getListAdminEnquiriesQueryKey() } });
  const update = useUpdateAdminEnquiry({ mutation: { meta: { success: 'Enquiry updated' } } });
  const invalidate = useInvalidate();
  if (enquiries.isLoading) return <LoadingBlock />;
  if (!enquiries.data?.length) return <EmptyState title="No enquiries yet." />;
  return (
    <div className="card-list">
      {enquiries.data.map((e) => (
        <article className="dash-card" key={e.id}>
          <div className="order-head"><div><span className="eyebrow">{e.kind === 'corporate' ? 'Corporate / bulk' : 'Contact'} · {dateTime(e.createdAt)}</span><h3>{e.companyName ? `${e.companyName} — ` : ''}{e.contactPerson}</h3></div>
            <select className="select-plain" value={e.status} onChange={(ev) => update.mutate({ id: e.id, data: { status: ev.target.value } }, { onSuccess: () => invalidate(getListAdminEnquiriesQueryKey()) })}><option value="new">New</option><option value="in_progress">In progress</option><option value="closed">Closed</option></select></div>
          <div className="kv-grid">
            <div className="kv"><span>Email</span><strong><a href={`mailto:${e.email}`}>{e.email}</a></strong></div><div className="kv"><span>Phone</span><strong>{e.phone ?? '—'}</strong></div>
            {e.kind === 'corporate' ? <>
              <div className="kv"><span>Quantity</span><strong>{e.quantity ?? '—'}</strong></div><div className="kv"><span>Required by</span><strong>{e.requiredDate ?? '—'}</strong></div>
              <div className="kv"><span>Preference</span><strong>{e.productPreference ?? '—'}</strong></div><div className="kv"><span>Delivery</span><strong>{e.deliveryLocation ?? '—'}</strong></div>
              <div className="kv"><span>Branding</span><strong>{e.brandingRequirements ?? '—'}</strong></div>
            </> : null}
          </div>
          {e.message ? <p>{e.message}</p> : null}
        </article>
      ))}
    </div>
  );
}

export function FraudSection() {
  const flags = useListFraudFlags({ query: { queryKey: getListFraudFlagsQueryKey() } });
  const update = useUpdateFraudFlag({ mutation: { meta: { success: 'Flag updated' } } });
  const reseller = useUpdateAdminReseller({ mutation: { meta: { success: 'Reseller updated' } } });
  const invalidate = useInvalidate();
  const refresh = { onSuccess: () => invalidate(getListFraudFlagsQueryKey(), getListAdminResellersQueryKey()) };
  if (flags.isLoading) return <LoadingBlock />;
  if (!flags.data?.length) return <EmptyState title="No flags raised.">Self-referrals, duplicate orders and accounts, suspicious referral activity, refund-related commissions and unusual order patterns will appear here.</EmptyState>;
  return (
    <div className="card-list">
      <MutationError error={update.error ?? reseller.error} />
      {flags.data.map((f) => (
        <article className={`dash-card ${f.status === 'open' ? '' : 'dim'}`} key={f.id} data-testid={`flag-${f.id}`}>
          <div className="order-head"><div><span className="eyebrow">{humanise(f.type)} · {dateTime(f.createdAt)}</span><h3>{f.detail}</h3></div><span><StatusPill status={f.severity} label={`${f.severity} severity`} /> <StatusPill status={f.status} /></span></div>
          <p className="muted small-text">{[f.orderNumber && `Order ${f.orderNumber}`, f.resellerCode && `Reseller ${f.resellerCode}`, f.userEmail && `Account ${f.userEmail}`].filter(Boolean).join(' · ')}</p>
          <div className="action-row">
            {f.status === 'open' ? <><button className="btn-ghost small" onClick={() => update.mutate({ id: f.id, data: { status: 'resolved' } }, refresh)}>Resolve</button><button className="btn-ghost small" onClick={() => update.mutate({ id: f.id, data: { status: 'dismissed' } }, refresh)}>Dismiss</button></> : <button className="btn-ghost small" onClick={() => update.mutate({ id: f.id, data: { status: 'open' } }, refresh)}>Reopen</button>}
            {f.resellerId ? <>
              <button className="btn-ghost small" onClick={() => reseller.mutate({ id: f.resellerId!, data: { standing: 'review' } }, refresh)}>Reseller → Review</button>
              <button className="btn-ghost small" onClick={() => reseller.mutate({ id: f.resellerId!, data: { standing: 'hold' } }, refresh)}>Reseller → Hold</button>
              <button className="btn-ghost small danger" onClick={() => reseller.mutate({ id: f.resellerId!, data: { standing: 'suspended' } }, refresh)}>Suspend reseller</button>
            </> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ marketing

/** Uploads a file (≤ 4 MB) and returns its URL; used for marketing materials and product images. */
export function FileUploadButton({ onUploaded, accept, label = 'Upload file' }: { onUploaded: (url: string, name: string) => void; accept?: string; label?: string }) {
  const upload = useUploadFile({ mutation: { meta: { success: 'File uploaded' } } });
  const [error, setError] = useState<string | null>(null);
  const pick = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setError('Files can be up to 4 MB — link larger files (e.g. videos) instead.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1] ?? '';
      upload.mutate({ data: { name: file.name, contentType: file.type || 'application/octet-stream', data } }, { onSuccess: (r) => onUploaded(r.url, r.name) });
    };
    reader.readAsDataURL(file);
  };
  return (
    <span className="upload-btn">
      <label className="btn-ghost small"><Upload size={14} /> {upload.isPending ? 'Uploading…' : label}<input type="file" hidden accept={accept} onChange={(e) => pick(e.target.files?.[0])} disabled={upload.isPending} /></label>
      {error ? <small className="bad-text">{error}</small> : null}
      <MutationError error={upload.error} />
    </span>
  );
}

const MATERIAL_CATEGORIES = ['product_images', 'descriptions', 'social', 'whatsapp', 'price_list', 'catalogue', 'campaign', 'video', 'training'];
const RANK_OPTIONS: Array<[string, string]> = [['reseller', 'All resellers'], ['team_leader', 'Team Leaders & above'], ['manager', 'Managers & above']];

function MaterialRow({ m }: { m: MarketingMaterial }) {
  const update = useUpdateMarketingMaterial({ mutation: { meta: { success: 'Material updated' } } });
  const remove = useDeleteMarketingMaterial({ mutation: { meta: { success: 'Material removed' } } });
  const invalidate = useInvalidate();
  const [edit, setEdit] = useState<null | { title: string; description: string; category: string; minRank: string; url: string }>(null);
  const done = { onSuccess: () => { setEdit(null); invalidate(getListAdminMarketingMaterialsQueryKey()); } };
  if (edit) {
    return (
      <tr className="detail-row"><td colSpan={4}>
        <div className="form-grid three">
          <div className="field"><label>Title</label><input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></div>
          <div className="field"><label>Category</label><select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{MATERIAL_CATEGORIES.map((c) => <option key={c} value={c}>{humanise(c)}</option>)}</select></div>
          <div className="field"><label>Visible to</label><select value={edit.minRank} onChange={(e) => setEdit({ ...edit, minRank: e.target.value })}>{RANK_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field full"><label>File or link</label><div className="inline-edit grow"><input value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} /><FileUploadButton label="Replace file" onUploaded={(url) => setEdit({ ...edit, url })} /></div></div>
          <div className="field full"><label>Description</label><input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
        </div>
        <div className="action-row"><button className="btn-primary small" disabled={update.isPending} onClick={() => update.mutate({ id: m.id, data: edit }, done)}>Save</button><button className="btn-ghost small" onClick={() => setEdit(null)}>Cancel</button></div>
        <MutationError error={update.error} />
      </td></tr>
    );
  }
  return (
    <tr>
      <td><a href={m.url} target="_blank" rel="noreferrer"><strong>{m.title}</strong></a><small>{m.description}</small>{m.url.startsWith('/api/files/') ? <small>Uploaded file</small> : null}</td>
      <td>{humanise(m.category)}</td><td>{rankLabel(m.minRank)}+</td>
      <td className="num">
        <button className="btn-ghost small" onClick={() => setEdit({ title: m.title, description: m.description, category: m.category, minRank: m.minRank, url: m.url })}>Edit</button>{' '}
        <button className="btn-ghost small danger" onClick={() => remove.mutate({ id: m.id }, { onSuccess: () => invalidate(getListAdminMarketingMaterialsQueryKey()) })}>Remove</button>
      </td>
    </tr>
  );
}

/** Promotional campaigns / announcements as in-app (and email) notifications. */
function AnnouncementCard() {
  const send = useSendAnnouncement();
  const [form, setForm] = useState<AnnouncementInput>({ audience: 'resellers', title: '', body: '', link: '', marketingOnly: true });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate({ data: { ...form, link: form.link || null } }, {
      onSuccess: (r) => { toast({ title: `Sent to ${r.count} ${r.count === 1 ? 'person' : 'people'}` }); setForm({ ...form, title: '', body: '', link: '' }); },
    });
  };
  return (
    <form className="dash-card" onSubmit={submit} data-testid="form-announcement">
      <h3><Megaphone size={16} /> Send an announcement</h3>
      <p className="muted small-text">Launches, promotions, campaigns or team news — delivered as a notification (and email when email is configured).</p>
      <div className="form-grid three">
        <div className="field"><label>Send to</label><select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as AnnouncementInput['audience'] })} data-testid="select-audience">
          <option value="resellers">All resellers</option><option value="team_leaders">Team Leaders & Managers</option><option value="managers">Managers</option><option value="customers">Customers</option><option value="everyone">Everyone</option>
        </select></div>
        <div className="field"><label>Title</label><input required minLength={2} maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="New: Jacaranda 100ml" data-testid="input-announcement-title" /></div>
        <div className="field"><label>Link (optional)</label><input value={form.link ?? ''} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="/shop/new-arrivals" /></div>
        <div className="field full"><label>Message</label><textarea required minLength={2} maxLength={2000} rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} data-testid="input-announcement-body" /></div>
      </div>
      {form.audience === 'customers' ? <label className="check-row"><input type="checkbox" checked={form.marketingOnly !== false} onChange={(e) => setForm({ ...form, marketingOnly: e.target.checked })} /> Only customers who opted in to marketing (required for promotions under POPIA)</label> : null}
      <div className="action-row"><button className="btn-primary small" type="submit" disabled={send.isPending} data-testid="button-send-announcement">{send.isPending ? 'Sending…' : 'Send announcement'}</button></div>
      <MutationError error={send.error} />
    </form>
  );
}

export function MarketingSection() {
  const materials = useListAdminMarketingMaterials({ query: { queryKey: getListAdminMarketingMaterialsQueryKey() } });
  const create = useCreateMarketingMaterial({ mutation: { meta: { success: 'Material added' } } });
  const invalidate = useInvalidate();
  const [form, setForm] = useState({ title: '', category: 'social', url: '', description: '', minRank: 'reseller' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ data: form }, { onSuccess: () => { setForm({ ...form, title: '', url: '', description: '' }); invalidate(getListAdminMarketingMaterialsQueryKey()); } });
  };
  return (
    <section>
      <AnnouncementCard />
      <form className="dash-card mt" onSubmit={submit} data-testid="form-material">
        <h3>Add marketing material</h3>
        <p className="muted small-text">Upload images, PDFs, price lists or slides (up to 4 MB), or paste a link for larger files such as videos.</p>
        <div className="form-grid three">
          <div className="field"><label>Title</label><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
          <div className="field"><label>Category</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{MATERIAL_CATEGORIES.map((c) => <option key={c} value={c}>{humanise(c)}</option>)}</select></div>
          <div className="field"><label>Visible to</label><select value={form.minRank} onChange={(e) => setForm({ ...form, minRank: e.target.value })}>{RANK_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div className="field full"><label>File or link</label>
            <div className="inline-edit grow"><input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://… or upload a file" data-testid="input-material-url" />
              <FileUploadButton onUploaded={(url, name) => setForm((f) => ({ ...f, url, title: f.title || name.replace(/\.[^.]+$/, '') }))} /></div>
          </div>
          <div className="field full"><label>Description</label><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        </div>
        <div className="action-row"><button className="btn-primary small" type="submit" disabled={create.isPending} data-testid="button-add-material">Add material</button></div>
        <MutationError error={create.error} />
      </form>
      {materials.data?.length ? (
        <div className="table-wrap mt"><table className="table compact"><thead><tr><th>Material</th><th>Category</th><th>Visible to</th><th /></tr></thead>
          <tbody>{materials.data.map((m) => <MaterialRow key={m.id} m={m} />)}</tbody></table></div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ settings & content

const SETTING_GROUPS: Array<{ title: string; note?: string; fields: Array<[keyof AdminSettings, string, 'int' | 'num' | 'bool' | 'text']> }> = [
  { title: 'Reseller ordering', note: 'Bulk pricing: "bottles:% off" pairs, e.g. 50:5,100:10 = 5% off reseller price from 50 bottles, 10% from 100. Leave empty for none.', fields: [['openingOrder', 'Minimum opening order (bottles)', 'int'], ['reorderMinimum', 'Re-order minimum (bottles)', 'int'], ['bulkDiscountTiers', 'Bulk pricing tiers', 'text']] },
  { title: 'Incentive percentages', note: 'Applied to qualifying wholesale product sales. Changes apply to new calculations.', fields: [['teamLeaderRate', 'Team Leader incentive (%)', 'num'], ['managerRate', 'Manager incentive (%)', 'num'], ['directorRate', 'Director incentive (%)', 'num'], ['directorEnabled', 'Director level enabled (Phase 3)', 'bool'], ['referralRate', 'Online referral sale commission (%) — optional', 'num'], ['countAttributedRetail', 'Count referral-link customer sales as reseller volume', 'bool']] },
  { title: 'Active reseller definition & inactivity', fields: [['activeMinBottles', 'Bottles per month to stay active', 'int'], ['reactivationBottles', 'Bottles in a month to reactivate', 'int'], ['rankGraceMonths', 'Warning (coaching) months before a leader reverts', 'int']] },
  { title: 'Team Leader requirements', fields: [['tlActiveDirects', 'Active direct resellers', 'int'], ['personalTarget', 'Personal bottles / month', 'int'], ['teamTarget', 'Qualifying team bottles / month', 'int']] },
  { title: 'Manager requirements', fields: [['mgrActiveTeamLeaders', 'Active Team Leaders', 'int'], ['mgrActiveResellers', 'Active resellers in organisation', 'int'], ['mgrOrgBottles', 'Organisation bottles / month', 'int'], ['mgrPersonalBottles', 'Personal bottles / month', 'int']] },
  { title: 'Director requirements (future phase)', fields: [['dirActiveManagers', 'Active Managers', 'int'], ['dirActiveResellers', 'Active resellers in organisation', 'int'], ['dirOrgBottles', 'Organisation bottles / month', 'int']] },
  { title: 'Store & targets', fields: [['shippingFlatRate', 'Delivery fee (R)', 'num'], ['freeShippingThreshold', 'Free delivery threshold (R)', 'num'], ['largeOrderBottles', 'Large order alert (bottles)', 'int'], ['monthlyContributionTarget', 'Monthly contribution target (R)', 'num']] },
];

const CONTENT_KEYS: Array<[string, string, boolean]> = [
  ['announcement', 'Announcement bar', false], ['heroEyebrow', 'Hero eyebrow', false], ['heroTitle', 'Hero headline', false], ['heroSubtitle', 'Hero sub-headline', true],
  ['brandIntro', 'Brand introduction', true], ['resellerPitch', 'Reseller opportunity copy', true], ['whatsappNumber', 'WhatsApp number (e.g. 27710000000)', false],
  ['contactEmail', 'Contact email', false], ['contactPhone', 'Contact phone', false], ['bankDetails', 'EFT banking details', true],
  ['instagramUrl', 'Instagram URL', false], ['facebookUrl', 'Facebook URL', false], ['tiktokUrl', 'TikTok URL', false],
];

export function SettingsSection() {
  const settings = useGetAdminSettings({ query: { queryKey: getGetAdminSettingsQueryKey() } });
  const updateSettings = useUpdateAdminSettings({ mutation: { meta: { success: 'Settings saved' } } });
  const home = useGetHomeSummary({ query: { queryKey: getGetHomeSummaryQueryKey() } });
  const updateContent = useUpdateSiteContent({ mutation: { meta: { success: 'Content saved' } } });
  const invalidate = useInvalidate();
  const [form, setForm] = useState<AdminSettingsInput | null>(null);
  const [content, setContent] = useState<Record<string, string> | null>(null);
  useEffect(() => { if (settings.data && !form) setForm(settings.data); }, [settings.data, form]);
  useEffect(() => { if (home.data && !content) setContent(home.data.content); }, [home.data, content]);
  if (settings.isLoading || !form) return settings.error ? <ErrorState error={settings.error} /> : <LoadingBlock />;
  const save = (e: FormEvent) => { e.preventDefault(); updateSettings.mutate({ data: form }, { onSuccess: (data) => { setForm(data); invalidate(getGetAdminSettingsQueryKey(), getGetStoreConfigQueryKey()); } }); };
  const saveContent = (e: FormEvent) => { e.preventDefault(); if (content) updateContent.mutate({ data: content }, { onSuccess: () => invalidate(getGetHomeSummaryQueryKey(), getGetStoreConfigQueryKey()) }); };
  return (
    <section>
      <form className="dash-card" onSubmit={save} data-testid="form-admin-settings">
        <div className="order-head"><div><span className="eyebrow">Compensation & qualification rules</span><h3>Nothing here is hard-coded — every rule is configurable.</h3></div>
          <button className="btn-primary small" type="submit" disabled={updateSettings.isPending} data-testid="button-save-settings">{updateSettings.isPending ? 'Saving…' : 'Save settings'}</button></div>
        {updateSettings.isSuccess ? <p className="ok-text" data-testid="status-settings-saved">Settings saved and recorded in the audit log.</p> : null}
        <MutationError error={updateSettings.error} />
        <div className="settings-groups">
          {SETTING_GROUPS.map((g) => (
            <fieldset key={g.title} className="settings-group"><legend>{g.title}</legend>{g.note ? <small className="muted">{g.note}</small> : null}
              {g.fields.map(([key, label, type]) => (
                <div className="setting-row" key={key}>
                  <label htmlFor={`setting-${key}`}>{label}</label>
                  {type === 'bool'
                    ? <input id={`setting-${key}`} type="checkbox" checked={Boolean(form[key])} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
                    : type === 'text'
                    ? <input id={`setting-${key}`} className="setting-text" placeholder="50:5,100:10" value={String(form[key] ?? '')} onChange={(e) => setForm({ ...form, [key]: e.target.value.replace(/\s/g, '') })} data-testid={`input-setting-${key}`} />
                    : <input id={`setting-${key}`} type="number" min={0} step={type === 'num' ? '0.01' : '1'} value={Number(form[key] ?? 0)} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} data-testid={`input-setting-${key}`} />}
                </div>
              ))}
            </fieldset>
          ))}
        </div>
      </form>
      <form className="dash-card mt" onSubmit={saveContent} data-testid="form-site-content">
        <div className="order-head"><div><span className="eyebrow">Website content</span><h3>Homepage copy, contact details & banking</h3></div><button className="btn-primary small" type="submit" disabled={updateContent.isPending}>Save content</button></div>
        {updateContent.isSuccess ? <p className="ok-text">Content saved.</p> : null}
        <MutationError error={updateContent.error} />
        {content ? <div className="form-grid">{CONTENT_KEYS.map(([key, label, long]) => (
          <div className={`field ${long ? 'full' : ''}`} key={key}><label htmlFor={`content-${key}`}>{label}</label>
            {long ? <textarea id={`content-${key}`} rows={2} value={content[key] ?? ''} onChange={(e) => setContent({ ...content, [key]: e.target.value })} /> : <input id={`content-${key}`} value={content[key] ?? ''} onChange={(e) => setContent({ ...content, [key]: e.target.value })} />}
          </div>
        ))}</div> : <LoadingBlock />}
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ reports & audit

const REPORTS: Array<{ id: ReportType; label: string }> = [
  { id: 'daily', label: 'Daily — orders, revenue, bottles, gross profit' },
  { id: 'weekly', label: 'Weekly — sales, reseller & team activity, top products' },
  { id: 'monthly', label: 'Monthly — revenue, costs, incentives, net contribution, customers' },
  { id: 'products', label: 'Product performance & stock' },
  { id: 'resellers', label: 'Reseller activity (month)' },
  { id: 'teams', label: 'Team activity (month)' },
  { id: 'commissions', label: 'Commission ledger' },
  { id: 'orders', label: 'Orders' },
];

export function ReportsSection() {
  const [type, setType] = useState<ReportType>('daily');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const params = { type, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const report = useGetAdminReport(params, { query: { queryKey: getGetAdminReportQueryKey(params) } });
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      const qs = new URLSearchParams({ ...params, format: 'csv' });
      const blob = await customFetch<Blob>(`/api/admin/reports?${qs}`, { responseType: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `masmila-${type}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <section>
      <div className="toolbar">
        <h2>Reports</h2>
        <select className="select-plain" value={type} onChange={(e) => setType(e.target.value as ReportType)} aria-label="Report type">{REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
        <label className="date-field">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="date-field">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn-primary small" onClick={() => void download()} disabled={downloading} data-testid="button-export-csv"><Download size={14} /> {downloading ? 'Preparing…' : 'Export CSV / Excel'}</button>
      </div>
      {report.isLoading ? <LoadingBlock /> : report.error ? <ErrorState error={report.error} /> : report.data ? (
        <div className="dash-card"><h3>{report.data.title}</h3>
          {report.data.rows.length ? <div className="table-wrap"><table className="table compact" data-testid="table-report"><thead><tr>{report.data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{report.data.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className={/^-?[\d.]+$/.test(cell) ? 'num' : ''}>{cell}</td>)}</tr>)}</tbody></table></div> : <p className="muted">No data for this range.</p>}
        </div>
      ) : null}
    </section>
  );
}

export function AuditSection() {
  const [entityType, setEntityType] = useState('');
  const params = entityType ? { entityType } : {};
  const logs = useListAuditLogs(params, { query: { queryKey: getListAuditLogsQueryKey(params) } });
  return (
    <section>
      <div className="toolbar"><h2>Audit trail</h2>
        <select className="select-plain" value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Entity type"><option value="">Everything</option>{['order', 'reseller', 'reseller_application', 'compensation_settings', 'product', 'commission_ledger', 'payout', 'period', 'user', 'fraud_flag', 'report', 'site_content'].map((t) => <option key={t} value={t}>{humanise(t)}</option>)}</select>
      </div>
      {logs.isLoading ? <LoadingBlock /> : !logs.data?.length ? <EmptyState title="No entries." /> : (
        <div className="table-wrap"><table className="table compact"><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>Actor</th><th>Details</th></tr></thead>
          <tbody>{logs.data.map((l) => <tr key={l.id}><td>{dateTime(l.createdAt)}</td><td>{humanise(l.action)}</td><td>{humanise(l.entityType)}<small>{l.entityId}</small></td><td>{l.actorId}</td><td><code className="meta">{l.metadata}</code></td></tr>)}</tbody></table></div>
      )}
    </section>
  );
}
