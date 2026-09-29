import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Copy,
  Menu,
  Search,
  ShoppingBag,
  Sparkles,
  X,
} from 'lucide-react';
import {
  getListProductsQueryKey,
  useGetAdminSummary,
  useGetHomeSummary,
  useGetResellerPortal,
  useListProducts,
  useSubmitResellerApplication,
  useUpdateAdminSettings,
} from '@workspace/api-client-react';
import type {
  AdminSettingsInput,
  Product,
  ResellerApplicationInput,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const money = (value: number) => `R${value.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;

function ProductVisual({ product }: { product: Product }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className="product-visual" data-testid={`visual-product-${product.id}`}>
      {product.image && !imageFailed ? <img className="product-image" src={product.image} alt={product.name} onError={() => setImageFailed(true)} /> : null}
      {!product.image || imageFailed ? <div className="product-bottle" aria-hidden="true" /> : null}
      {product.badge ? <span className="eyebrow" style={{ position: 'absolute', zIndex: 2, top: 16, left: 16, background: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))', padding: '7px 9px', borderRadius: 2 }}>{product.badge}</span> : null}
    </div>
  );
}

function ProductCard({ product, onAdd }: { product: Product; onAdd: (product: Product) => void }) {
  return (
    <article className="product-card reveal" data-testid={`card-product-${product.id}`}>
      <ProductVisual product={product} />
      <div className="product-info">
        <span className="eyebrow">{product.family}</span>
        <h3 data-testid={`text-product-name-${product.id}`}>{product.name}</h3>
        <div className="product-meta"><span>{product.size} · {product.category}</span><strong>{money(product.price)}</strong></div>
        <button className="product-add" onClick={() => onAdd(product)} data-testid={`button-add-product-${product.id}`}>Add to bag <ArrowRight size={14} /></button>
      </div>
    </article>
  );
}

function LoadingProducts() {
  return <div className="product-grid" data-testid="loading-products">{[1, 2, 3, 4].map((item) => <div key={item}><div className="skeleton" style={{ aspectRatio: '.82' }} /><div className="skeleton" style={{ height: 20, marginTop: 15, width: '65%' }} /><div className="skeleton" style={{ height: 13, marginTop: 9, width: '90%' }} /></div>)}</div>;
}

function DataState({ loading, error, onRetry, children }: { loading: boolean; error: unknown; onRetry: () => void; children: ReactNode }) {
  if (loading) return <LoadingProducts />;
  if (error) return <div className="error-state" data-testid="state-error"><span className="eyebrow">A small detour</span><h2>We could not load this just now.</h2><p>Our catalogue is taking a moment. Try again and the good stuff should be waiting.</p><button className="btn-primary" onClick={onRetry} data-testid="button-retry">Try again <ArrowRight size={15} /></button></div>;
  return <>{children}</>;
}

function Nav({ bagCount }: { bagCount: number }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const links = [{ href: '/', label: 'Home' }, { href: '/shop', label: 'Shop' }, { href: '/about', label: 'Our story' }, { href: '/reseller', label: 'Resell with us' }];
  return <header className="container-wide site-nav" data-testid="navigation">
    <Link href="/" className="brand-mark" data-testid="link-home">Mas<span>'</span>Mila</Link>
    <nav className={`nav-links ${open ? 'open' : ''}`} aria-label="Main navigation">
      {links.map((link) => <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className={`nav-link ${location === link.href ? 'active' : ''}`} data-testid={`link-nav-${link.label.toLowerCase().replaceAll(' ', '-')}`}>{link.label}</Link>)}
    </nav>
    <div className="nav-actions">
      <Link href="/portal" className="nav-link" data-testid="link-portal">Portal</Link>
      <button className="bag-button" onClick={() => window.alert(`Your bag has ${bagCount} item${bagCount === 1 ? '' : 's'}.`)} data-testid="button-open-bag"><ShoppingBag size={15} /> Bag ({bagCount})</button>
      <button className="icon-button mobile-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Close menu' : 'Open menu'} data-testid="button-mobile-menu">{open ? <X size={18} /> : <Menu size={18} />}</button>
    </div>
  </header>;
}

function Footer() {
  return <footer className="footer"><div className="container-wide footer-grid">
    <div><Link href="/" className="brand-mark" data-testid="link-footer-home">Mas<span>'</span>Mila</Link><p>Fragrance for the everyday main character. Made in South Africa, shared wherever you are.</p></div>
    <div><h4>Explore</h4><Link className="footer-link" href="/shop" data-testid="link-footer-shop">Shop scents</Link><Link className="footer-link" href="/about" data-testid="link-footer-about">Our story</Link><Link className="footer-link" href="/reseller" data-testid="link-footer-reseller">Become a reseller</Link></div>
    <div><h4>For partners</h4><Link className="footer-link" href="/portal" data-testid="link-footer-portal">Reseller portal</Link><Link className="footer-link" href="/admin" data-testid="link-footer-admin">Admin workspace</Link><span className="footer-link">hello@masmila.co.za</span></div>
  </div><div className="container-wide footer-bottom"><span>© 2024 Mas'Mila Fragrances</span><span>Johannesburg · South Africa</span></div></footer>;
}

function HomePage({ onAdd }: { onAdd: (product: Product) => void }) {
  const home = useGetHomeSummary();
  return <main>
    <section className="container-wide hero"><div className="hero-copy reveal">
      <span className="eyebrow">South African fragrance, made personal</span>
      <h1 className="display-xl">Leave a little <em>impression.</em></h1>
      <p className="body-lg">Everyday scents with enough point of view to become yours. Find the note that follows you into the room.</p>
      <div className="hero-actions"><Link href="/shop" className="btn-primary" data-testid="button-hero-shop">Shop the collection <ArrowRight size={16} /></Link><Link href="/reseller" className="btn-ghost" data-testid="button-hero-reseller">Build with Mas'Mila</Link></div>
      <div style={{ display: 'flex', gap: 28, marginTop: 52 }}><div><strong className="font-display" style={{ fontSize: 29 }}>{home.data?.totalProducts ?? '—'}</strong><span style={{ display: 'block', fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>signature scents</span></div><div><strong className="font-display" style={{ fontSize: 29 }}>SA</strong><span style={{ display: 'block', fontSize: 11, color: 'hsl(var(--muted-foreground))' }}>born & blended</span></div></div>
    </div><div className="hero-art reveal delay-2" aria-label="Mas'Mila signature fragrance bottle"><div className="hero-bottle" /><div className="hero-sticker">Scent is<br />your signature</div></div></section>
    <section className="section section-tint"><div className="container-wide"><div className="section-head"><div><span className="eyebrow">The edit</span><h2 className="display-md">Meet your new<br />daily ritual.</h2></div><Link href="/shop" className="btn-ghost" data-testid="button-view-all-products">View all scents <ArrowRight size={15} /></Link></div>
      <DataState loading={home.isLoading} error={home.error} onRetry={() => home.refetch()}>{home.data?.featured?.length ? <div className="product-grid">{home.data.featured.slice(0, 4).map((product) => <ProductCard key={product.id} product={product} onAdd={onAdd} />)}</div> : <div className="empty-state" data-testid="state-empty-featured"><h2>The edit is resting.</h2><p>There are no featured scents right now. Visit the full collection to browse what is in stock.</p><Link className="btn-primary" href="/shop" data-testid="button-empty-shop">Browse collection</Link></div>}</DataState>
    </div></section>
    <section className="section"><div className="container-wide feature-band"><div><span className="eyebrow">More than a bottle</span><h2 className="display-md">A fragrance business that smells like possibility.</h2><p className="body-lg">Mas'Mila gives ambitious people a simple offer, beautiful product and a real route to build income through sales.</p><Link className="btn-ink" href="/reseller" data-testid="button-home-opportunity">See the opportunity <ArrowRight size={15} /></Link></div><div className="feature-panel"><span className="eyebrow" style={{ color: 'hsl(var(--accent))' }}>For the next chapter</span><h3 className="display-md" style={{ margin: '28px 0 18px', maxWidth: 440 }}>Sell a scent people already want to wear.</h3><p>Start with a considered opening order. Learn the range. Let your customer list become your community.</p><div className="story-lines" style={{ marginTop: 42 }}><div><strong>01</strong><span>Choose your opening range</span></div><div><strong>02</strong><span>Sell with confidence</span></div><div><strong>03</strong><span>Grow into leadership</span></div></div></div></div></section>
  </main>;
}

function ShopPage({ onAdd }: { onAdd: (product: Product) => void }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const params = useMemo(() => ({ ...(category ? { category } : {}), ...(search ? { search } : {}), limit: 24 }), [category, search]);
  const products = useListProducts(params, { query: { queryKey: getListProductsQueryKey(params) } });
  const categories = ['All scents', 'Women', 'Men', 'Unisex', 'Home'];
  return <main className="container-wide"><div className="page-intro"><span className="eyebrow">The collection</span><h1 className="display-lg">Find the note<br />that feels like you.</h1><p className="body-lg">A focused wardrobe of fragrance families, from clean skin scents to warm, late-night woods.</p></div><div className="shop-layout"><aside className="filter-panel"><h3>Browse by</h3><div className="filter-list">{categories.map((item) => <button key={item} className={`filter-button ${category === (item === 'All scents' ? '' : item) ? 'selected' : ''}`} onClick={() => setCategory(item === 'All scents' ? '' : item)} data-testid={`button-filter-${item.toLowerCase().replaceAll(' ', '-')}`}>{item}</button>)}</div><div style={{ marginTop: 44, paddingTop: 20, borderTop: '1px solid hsl(var(--border))' }}><span className="eyebrow">Good to know</span><p style={{ color: 'hsl(var(--muted-foreground))', fontSize: 12, lineHeight: 1.65 }}>Wear it on your skin, not your expectations. Every Mas'Mila scent is designed to live with you.</p></div></aside><section><div className="search-row"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, family or note" aria-label="Search fragrances" data-testid="input-search-products" />{search ? <button className="icon-button" style={{ width: 24, height: 24, border: 0 }} onClick={() => setSearch('')} data-testid="button-clear-search"><X size={13} /></button> : null}</label><span className="count-label" data-testid="text-product-count">{products.data?.length ?? 0} results</span></div><DataState loading={products.isLoading} error={products.error} onRetry={() => products.refetch()}>{products.data?.length ? <div className="product-grid">{products.data.map((product) => <ProductCard key={product.id} product={product} onAdd={onAdd} />)}</div> : <div className="empty-state" data-testid="state-empty-products"><Sparkles size={20} color="hsl(var(--primary))" /><h2>No scent by that name.</h2><p>Try another search, or clear the filters and let your nose lead.</p><button className="btn-ghost" onClick={() => { setSearch(''); setCategory(''); }} data-testid="button-clear-filters">Clear filters</button></div>}</DataState></section></div></main>;
}

function AboutPage() {
  return <main><section className="container-wide page-intro" style={{ maxWidth: 900 }}><span className="eyebrow">The Mas'Mila point of view</span><h1 className="display-lg">We believe scent<br /><em style={{ color: 'hsl(var(--primary))', fontStyle: 'normal' }}>belongs to everyone.</em></h1><p className="body-lg" style={{ maxWidth: 620 }}>Not saved for special occasions. Not hidden behind a glass counter. Mas'Mila makes fragrance that moves with real lives — and a business model that does too.</p></section><section className="section section-tint"><div className="container-wide feature-band"><div className="feature-panel" style={{ minHeight: 460, background: 'hsl(var(--primary))' }}><span className="eyebrow" style={{ color: 'hsl(var(--accent-foreground))' }}>Our beginning</span><h2 className="display-md" style={{ marginTop: 30 }}>A bold idea in a small bottle.</h2><p style={{ color: 'rgba(255,245,223,.76)' }}>Mas'Mila started with a simple observation: the right fragrance changes how you enter a room. We wanted to make that feeling more accessible — then make the opportunity to share it just as tangible.</p></div><div><span className="eyebrow">What we stand for</span><div className="story-lines" style={{ display: 'grid', gridTemplateColumns: '1fr', marginTop: 28 }}><div><strong>01 / Personal</strong><span>There is no one right way to wear a scent. Our range gives you room to make it yours.</span></div><div><strong>02 / Considered</strong><span>We care about the small things: how it opens, how it settles, and how it feels to gift.</span></div><div><strong>03 / Possible</strong><span>We build products people want to buy, and a business path that rewards showing up consistently.</span></div></div></div></div></section><section className="section"><div className="container-wide" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}><div><span className="eyebrow">Made here</span><h2 className="display-md" style={{ marginTop: 14 }}>South African roots.</h2></div><p className="body-lg">Warm sunlight, sharp style, generous energy. Our point of view is shaped by a place that knows how to hold contrast.</p><p className="body-lg">We are building a fragrance house with open doors — for wearers, makers, sellers and the people they bring along.</p></div></section></main>;
}

const initialApplication: ResellerApplicationInput = { firstName: '', surname: '', mobile: '', email: '', province: '', city: '', contactMethod: 'WhatsApp', heardAbout: '', referringCode: '', termsAccepted: false, privacyAccepted: false };
function ResellerPage() {
  const [form, setForm] = useState<ResellerApplicationInput>(initialApplication);
  const application = useSubmitResellerApplication();
  const update = (key: keyof ResellerApplicationInput, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => { event.preventDefault(); application.mutate({ data: form }); };
  if (application.isSuccess) return <main className="container-wide form-shell"><div className="form-aside"><span className="eyebrow">Application received</span><h1 className="display-lg">This could be<br />the beginning.</h1><p className="body-lg">We will be in touch with the next steps for your Mas'Mila journey.</p></div><div className="form-card" style={{ alignSelf: 'center', textAlign: 'center', paddingBlock: 62 }} data-testid="state-application-success"><Check size={35} color="hsl(var(--primary))" /><h2>{application.data?.message || 'Your application is on its way.'}</h2><p style={{ color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, fontSize: 13 }}>Keep an eye on your phone and inbox. Your application reference is <strong>{application.data?.id}</strong>.</p><Link className="btn-ink" href="/" data-testid="button-success-home">Back to Mas'Mila</Link></div></main>;
  return <main className="container-wide form-shell"><div className="form-aside"><span className="eyebrow">The opportunity</span><h1 className="display-lg">Make room<br />for more.</h1><p className="body-lg">Become a Mas'Mila reseller and build a fragrance business around products people are proud to recommend.</p><div className="aside-note"><strong>What you get</strong><br />A considered opening range, support that answers the phone, and a clear path from first sale to team leadership.</div></div><form className="form-card" onSubmit={submit} data-testid="form-reseller-application"><h2>Tell us about yourself.</h2>{application.error ? <div className="form-message" data-testid="state-application-error">We could not send that through. Please check your details and try again.</div> : null}<div className="form-grid"><div className="field"><label htmlFor="firstName">First name</label><input id="firstName" required value={form.firstName} onChange={(e) => update('firstName', e.target.value)} data-testid="input-first-name" /></div><div className="field"><label htmlFor="surname">Surname</label><input id="surname" required value={form.surname} onChange={(e) => update('surname', e.target.value)} data-testid="input-surname" /></div><div className="field"><label htmlFor="mobile">Mobile number</label><input id="mobile" required minLength={8} value={form.mobile} onChange={(e) => update('mobile', e.target.value)} data-testid="input-mobile" /></div><div className="field"><label htmlFor="email">Email address</label><input id="email" required type="email" value={form.email} onChange={(e) => update('email', e.target.value)} data-testid="input-email" /></div><div className="field"><label htmlFor="province">Province</label><input id="province" required value={form.province} onChange={(e) => update('province', e.target.value)} data-testid="input-province" /></div><div className="field"><label htmlFor="city">City / town</label><input id="city" required value={form.city} onChange={(e) => update('city', e.target.value)} data-testid="input-city" /></div><div className="field"><label htmlFor="contactMethod">Best way to reach you</label><select id="contactMethod" value={form.contactMethod} onChange={(e) => update('contactMethod', e.target.value)} data-testid="select-contact-method"><option>WhatsApp</option><option>Phone call</option><option>Email</option></select></div><div className="field"><label htmlFor="heardAbout">How did you hear about us?</label><select id="heardAbout" required value={form.heardAbout} onChange={(e) => update('heardAbout', e.target.value)} data-testid="select-heard-about"><option value="">Choose one</option><option>Friend or reseller</option><option>Social media</option><option>Event</option><option>Search</option></select></div><div className="field full"><label htmlFor="referringCode">Referring reseller code <span style={{ opacity: .55 }}>(optional)</span></label><input id="referringCode" value={form.referringCode ?? ''} onChange={(e) => update('referringCode', e.target.value)} data-testid="input-referring-code" /></div></div><label className="check-row"><input type="checkbox" required checked={form.termsAccepted} onChange={(e) => update('termsAccepted', e.target.checked)} data-testid="checkbox-terms" /><span>I agree to the reseller terms and understand that this is an independent sales opportunity.</span></label><label className="check-row"><input type="checkbox" required checked={form.privacyAccepted} onChange={(e) => update('privacyAccepted', e.target.checked)} data-testid="checkbox-privacy" /><span>I agree to the processing of my information so Mas'Mila can respond to this application.</span></label><div className="submit-row"><span className="count-label">Takes about 2 minutes</span><button className="btn-primary" type="submit" disabled={application.isPending} data-testid="button-submit-application">{application.isPending ? 'Sending application…' : 'Submit application'} <ArrowRight size={15} /></button></div></form></main>;
}

function PortalPage() {
  const portal = useGetResellerPortal();
  return <main className="container-wide dashboard-wrap"><DataState loading={portal.isLoading} error={portal.error} onRetry={() => portal.refetch()}>{portal.data ? <><div className="dashboard-top"><div><span className="eyebrow">Reseller portal · {portal.data.resellerId}</span><h1 className="display-md">Good morning, {portal.data.name.split(' ')[0]}.</h1></div><div className="dashboard-user"><strong>{portal.data.rank}</strong>{portal.data.status} · Code {portal.data.referralCode}</div></div><div className="metric-grid"><div className="metric-card primary"><span className="metric-label">Personal sales</span><span className="metric-value">{money(portal.data.personalSales)}</span><span className="metric-detail">Your fragrance business, this month</span></div><div className="metric-card"><span className="metric-label">Personal bottles</span><span className="metric-value">{portal.data.personalBottles}</span><span className="metric-detail">units sold</span></div><div className="metric-card"><span className="metric-label">Team bottles</span><span className="metric-value">{portal.data.teamBottles}</span><span className="metric-detail">{portal.data.teamLeaders} team leaders</span></div><div className="metric-card"><span className="metric-label">Incentive earned</span><span className="metric-value">{money(portal.data.incentive)}</span><span className="metric-detail">pending this cycle</span></div></div><div className="dashboard-grid"><section className="dash-card"><h2>Your next rank</h2><div className="rank-row"><span>{portal.data.rank}</span><span>{portal.data.progress}% to {portal.data.nextRank}</span></div><div className="progress-track"><div className="progress-bar" style={{ width: `${Math.min(portal.data.progress, 100)}%` }} /></div><p style={{ fontSize: 13, color: 'hsl(var(--muted-foreground))', lineHeight: 1.6, marginTop: 22 }}>Keep sharing the scents people love. Your next milestone unlocks stronger team rewards and a bigger say in the community.</p><div className="feature-panel" style={{ minHeight: 0, padding: 22, marginTop: 30, background: 'hsl(var(--secondary))' }}><span className="eyebrow" style={{ color: 'hsl(var(--accent))' }}>Your referral code</span><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 15, marginTop: 14 }}><strong className="font-mono-brand" style={{ fontSize: 24 }}>{portal.data.referralCode}</strong><button className="icon-button" onClick={() => navigator.clipboard?.writeText(portal.data!.referralCode)} aria-label="Copy referral code" data-testid="button-copy-referral"><Copy size={16} /></button></div></div></section><section className="dash-card"><h2>Recent movement</h2>{portal.data.activity?.length ? <div className="activity-list">{portal.data.activity.map((item) => <div className="activity-item" key={item.id} data-testid={`activity-${item.id}`}><i className="activity-dot" /><div><strong>{item.label}</strong><span>{item.detail}</span></div><time>{item.time}</time></div>)}</div> : <div className="empty-state"><p>No activity yet. Your first sale will show up here.</p></div>}</section></div></> : null}</DataState></main>;
}

const defaultSettings: AdminSettingsInput = { openingOrder: 1500, teamLeaderRate: 8, managerRate: 12, directorRate: 16, personalTarget: 30, teamTarget: 120 };
function AdminPage() {
  const summary = useGetAdminSummary();
  const updateSettings = useUpdateAdminSettings();
  const [settings, setSettings] = useState<AdminSettingsInput>(defaultSettings);
  const [saved, setSaved] = useState(false);
  const setNumber = (key: keyof AdminSettingsInput, value: string) => { setSaved(false); setSettings((current) => ({ ...current, [key]: Number(value) })); };
  const save = (event: FormEvent) => { event.preventDefault(); updateSettings.mutate({ data: settings }, { onSuccess: () => setSaved(true) }); };
  return <main className="container-wide dashboard-wrap"><DataState loading={summary.isLoading} error={summary.error} onRetry={() => summary.refetch()}>{summary.data ? <><div className="dashboard-top"><div><span className="eyebrow">Admin workspace · live view</span><h1 className="display-md">The business, in focus.</h1></div><Link href="/shop" className="btn-ghost" data-testid="button-admin-shop">View storefront <ArrowRight size={15} /></Link></div><div className="metric-grid"><div className="metric-card primary"><span className="metric-label">Revenue this month</span><span className="metric-value">{money(summary.data.revenue)}</span><span className="metric-detail">Across all sales channels</span></div><div className="metric-card"><span className="metric-label">Bottles moved</span><span className="metric-value">{summary.data.bottles}</span><span className="metric-detail">this month</span></div><div className="metric-card"><span className="metric-label">Active resellers</span><span className="metric-value">{summary.data.activeResellers}</span><span className="metric-detail">in the network</span></div><div className="metric-card"><span className="metric-label">Pending incentives</span><span className="metric-value">{money(summary.data.pendingIncentives)}</span><span className="metric-detail">to be processed</span></div></div><div className="dashboard-grid"><section className="dash-card"><h2>Weekly sales</h2><div className="chart" data-testid="chart-weekly-sales">{summary.data.weeklySales.map((point) => { const max = Math.max(...summary.data!.weeklySales.map((item) => item.value), 1); return <div className="bar-wrap" key={point.label}><div className="bar" style={{ height: `${Math.max((point.value / max) * 100, 7)}%` }} title={`${point.label}: ${point.value}`} data-testid={`bar-sales-${point.label}`} /><span className="bar-label">{point.label}</span></div>; })}</div></section><section className="dash-card"><h2>Top products</h2>{summary.data.topProducts?.length ? <div className="ranked-list">{summary.data.topProducts.map((product, index) => <div className="ranked-row" key={product.name} data-testid={`row-top-product-${index}`}><span className="ranked-number">0{index + 1}</span><span><strong>{product.name}</strong><small>{product.units} bottles</small></span><strong>{money(product.revenue)}</strong></div>)}</div> : <div className="empty-state"><p>No product performance data yet.</p></div>}</section></div><section className="dash-card" style={{ marginTop: 16 }}><div className="section-head" style={{ marginBottom: 20 }}><div><span className="eyebrow">Editable controls</span><h2 style={{ fontFamily: 'var(--app-font-serif)', fontSize: 25, margin: '9px 0 0' }}>Compensation settings</h2></div>{saved ? <span style={{ color: 'hsl(var(--primary))', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }} data-testid="status-settings-saved"><Check size={14} /> Settings saved</span> : null}</div><form className="settings-form" onSubmit={save} data-testid="form-admin-settings"><div className="form-grid">{([['openingOrder', 'Opening order (R)'], ['teamLeaderRate', 'Team leader rate (%)'], ['managerRate', 'Manager rate (%)'], ['directorRate', 'Director rate (%)'], ['personalTarget', 'Personal bottle target'], ['teamTarget', 'Team bottle target']] as [keyof AdminSettingsInput, string][]).map(([key, label]) => <div className="field" key={key}><label htmlFor={`setting-${key}`}>{label}</label><input id={`setting-${key}`} type="number" min="0" value={settings[key]} onChange={(e) => setNumber(key, e.target.value)} data-testid={`input-setting-${key}`} /></div>)}</div><div className="submit-row" style={{ marginTop: 10 }}><span className="count-label">Changes apply to new incentive calculations.</span><button className="btn-primary" disabled={updateSettings.isPending} type="submit" data-testid="button-save-settings">{updateSettings.isPending ? 'Saving…' : 'Save settings'} <ArrowRight size={15} /></button></div>{updateSettings.error ? <div className="form-message" data-testid="state-settings-error">Settings could not be saved. Try again.</div> : null}</form></section></> : null}</DataState></main>;
}

function AppShell() {
  const [bag, setBag] = useState<Product[]>([]);
  const addToBag = (product: Product) => setBag((items) => [...items, product]);
  return <div className="site-shell grain"><Nav bagCount={bag.length} /><Switch><Route path="/" component={() => <HomePage onAdd={addToBag} />} /><Route path="/shop" component={() => <ShopPage onAdd={addToBag} />} /><Route path="/about" component={AboutPage} /><Route path="/reseller" component={ResellerPage} /><Route path="/portal" component={PortalPage} /><Route path="/admin" component={AdminPage} /><Route component={NotFound} /></Switch><Footer /></div>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><AppShell /></ErrorBoundary>;
}

export default function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}