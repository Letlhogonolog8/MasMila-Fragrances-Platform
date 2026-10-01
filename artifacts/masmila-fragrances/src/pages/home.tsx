import { useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight, BadgeCheck, Facebook, Gift, Instagram, Music2, Quote, RotateCcw, ShieldCheck, Sparkles, Star, Truck,
} from 'lucide-react';
import { WhatsAppIcon } from '@/components/whatsapp-icon';
import { getGetHomeSummaryQueryKey, useGetHomeSummary, type Product } from '@workspace/api-client-react';
import { ErrorState, LoadingGrid, ProductCard } from '@/components/bits';
import { Newsletter, useStoreConfig, whatsappLink } from '@/components/site';
import { FAMILY_SWATCH, imageFor } from '@/lib/bottle';
import { money } from '@/lib/format';
import { useSeo } from '@/lib/seo';

const FAMILY_BLURBS: Record<string, string> = {
  Floral: 'Rose, peony, jasmine',
  Fresh: 'Clean, green, aquatic',
  Fruity: 'Juicy berries & marula',
  Woody: 'Sandalwood, cedar, vetiver',
  Oriental: 'Amber, spice, oud',
  Sweet: 'Vanilla, praline, honey',
  Citrus: 'Bergamot, lemon, neroli',
};

type ShowcaseTab = 'featured' | 'best' | 'new';

/** Featured, best sellers and new arrivals in one tabbed row (swipeable on phones). */
function Showcase({ featured, best, fresh, loading, error, onRetry }: { featured: Product[]; best: Product[]; fresh: Product[]; loading: boolean; error: unknown; onRetry: () => void }) {
  const [tab, setTab] = useState<ShowcaseTab>('featured');
  const tabs: Array<{ id: ShowcaseTab; label: string; href: string; items: Product[] }> = [
    { id: 'featured', label: 'Featured', href: '/shop', items: featured },
    { id: 'best', label: 'Best sellers', href: '/shop/best-sellers', items: best },
    { id: 'new', label: 'New arrivals', href: '/shop/new-arrivals', items: fresh },
  ];
  const current = tabs.find((t) => t.id === tab)!;
  return (
    <section className="section" id="collections" data-testid="section-showcase">
      <div className="container-wide">
        <div className="section-head">
          <div><span className="eyebrow">The edit</span><h2 className="display-md">Find your next signature.</h2></div>
          <div className="showcase-tabs" role="tablist" aria-label="Collections">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-testid={`tab-showcase-${t.id}`}>{t.label}</button>
            ))}
          </div>
        </div>
        {/* Keep every collection in the DOM for SEO; only the active one is shown. */}
        {loading ? <LoadingGrid /> : error ? <ErrorState error={error} onRetry={onRetry} /> : tabs.map((t) => (
          <div key={t.id} role="tabpanel" hidden={t.id !== tab} data-testid={t.id === 'featured' ? 'section-featured' : t.id === 'best' ? 'section-best-sellers' : 'section-new-arrivals'}>
            {t.items.length ? <div className="product-grid scroller">{t.items.slice(0, 4).map((p) => <ProductCard key={p.id} product={p} />)}</div> : <div className="empty-state"><p>New scents are on their way.</p></div>}
          </div>
        ))}
        <div className="showcase-foot"><Link href={current.href} className="btn-ghost">View all {current.label.toLowerCase()} <ArrowRight size={15} /></Link></div>
      </div>
    </section>
  );
}

function Stars() {
  return <span className="stars" aria-label="5 out of 5 stars">{Array.from({ length: 5 }, (_, i) => <Star key={i} size={13} fill="currentColor" />)}</span>;
}

export default function HomePage() {
  const home = useGetHomeSummary({ query: { queryKey: getGetHomeSummaryQueryKey() } });
  const config = useStoreConfig();
  const c = home.data?.content ?? {};
  const heroBottles = (home.data?.featured ?? []).slice(0, 3);
  useSeo({
    title: "Mas'Mila Fragrances | Affordable 50ml & 100ml Perfume in South Africa",
    description: "Shop long-lasting, affordable South African perfume — women's, men's and unisex fragrances in 50ml and 100ml, perfect perfume gifts. Or start a perfume business as a Mas'Mila reseller.",
    jsonLd: { '@context': 'https://schema.org', '@type': 'Organization', name: "Mas'Mila Fragrances", url: window.location.origin, logo: `${window.location.origin}/logo.svg`, sameAs: [c.instagramUrl, c.facebookUrl, c.tiktokUrl].filter(Boolean) },
  });
  const retry = () => void home.refetch();
  const freeFrom = config.data ? money(config.data.freeShippingThreshold).replace(/,00$/, '') : 'R750';

  return (
    <main>
      {/* 1. Hero */}
      <section className="container-wide hero hero-v2" data-testid="section-hero">
        <div className="hero-copy reveal">
          <span className="eyebrow">{c.heroEyebrow ?? 'South African fragrance, made personal'}</span>
          <h1 className="display-xl">{c.heroTitle ?? 'Wear the fragrance. Build the business.'}</h1>
          <p className="body-lg">{c.heroSubtitle}</p>
          <div className="hero-actions">
            <Link href="/shop" className="btn-primary" data-testid="button-hero-shop">SHOP MAS'MILA <ArrowRight size={16} /></Link>
            <Link href="/become-a-reseller" className="btn-ghost" data-testid="button-hero-reseller">BECOME A RESELLER</Link>
          </div>
          <div className="quick-links" aria-label="Shop by category">
            <span>Shop:</span>
            <Link href="/shop/women">Women</Link><Link href="/shop/men">Men</Link><Link href="/shop/unisex">Unisex</Link><Link href="/shop/best-sellers">Best sellers</Link>
          </div>
          <div className="hero-proof"><Stars /><span>Loved by customers & resellers across South Africa</span></div>
        </div>
        <div className="hero-art reveal delay-2" aria-hidden="true">
          {heroBottles.length ? (
            <div className="hero-bottles">
              {heroBottles.map((p, i) => <img key={p.id} className={`hb hb-${i}`} src={imageFor(p)} alt="" />)}
            </div>
          ) : <div className="hero-bottle" />}
          <div className="hero-sticker">Smell good.<br />Sell more.</div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="trust-strip" aria-label="Why shop with Mas'Mila">
        <div className="container-wide trust-grid">
          <div><Truck size={20} /><span><strong>Free delivery over {freeFrom}</strong>Nationwide courier</span></div>
          <div><Sparkles size={20} /><span><strong>Long-lasting EDP</strong>50ml & 100ml</span></div>
          <div><ShieldCheck size={20} /><span><strong>Secure checkout</strong>Card, Instant EFT or EFT</span></div>
          <div><RotateCcw size={20} /><span><strong>Easy returns</strong>30 days on unopened items</span></div>
        </div>
      </section>

      {/* 2. Brand introduction */}
      <section className="section section-tint compact" data-testid="section-brand-intro">
        <div className="container-wide split">
          <div><span className="eyebrow">Meet Mas'Mila</span><h2 className="display-md">A fragrance brand, a lifestyle and a business opportunity.</h2></div>
          <div>
            <p className="body-lg">{c.brandIntro}</p>
            <div className="stat-row">
              <div><strong>{home.data?.totalProducts ?? '—'}</strong><span>signature scents</span></div>
              <div><strong>7</strong><span>fragrance families</span></div>
              <div><strong>9</strong><span>provinces delivered</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* 3, 5, 6. Featured / Best sellers / New arrivals */}
      <Showcase featured={home.data?.featured ?? []} best={home.data?.bestSellers ?? []} fresh={home.data?.newArrivals ?? []} loading={home.isLoading} error={home.error} onRetry={retry} />

      {/* 4. Shop by fragrance family */}
      <section className="section section-tint" data-testid="section-families">
        <div className="container-wide">
          <div className="section-head"><div><span className="eyebrow">Find your note</span><h2 className="display-md">Shop by fragrance family</h2></div></div>
          <div className="family-grid">
            {(home.data?.families ?? Object.keys(FAMILY_BLURBS).map((name) => ({ name, count: 0 }))).map((f) => (
              <Link key={f.name} href={`/shop?family=${encodeURIComponent(f.name)}`} className="family-tile" style={{ ['--swatch' as string]: FAMILY_SWATCH[f.name] ?? 'hsl(var(--primary))' }} data-testid={`link-family-${f.name.toLowerCase()}`}>
                <i className="swatch" aria-hidden="true" />
                <strong>{f.name === 'Oriental' ? 'Oriental / amber' : f.name}</strong><span>{FAMILY_BLURBS[f.name] ?? ''}</span><small>{f.count ? `${f.count} fragrances` : 'Explore'} →</small>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 7 & 8. Become a reseller + opportunity */}
      <section className="section" data-testid="section-reseller">
        <div className="container-wide feature-band">
          <div>
            <span className="eyebrow">Become a Mas'Mila reseller</span>
            <h2 className="display-md">Smell good. Sell more. Build Mas'Mila.</h2>
            <p className="body-lg">{c.resellerPitch}</p>
            <ul className="check-list">
              <li><BadgeCheck size={16} /> No joining fee — your opening order is saleable stock</li>
              <li><BadgeCheck size={16} /> Reseller prices, portal, referral link & QR code</li>
              <li><BadgeCheck size={16} /> Earnings linked to real product sales only</li>
            </ul>
            <div className="hero-actions"><Link className="btn-primary" href="/become-a-reseller" data-testid="button-home-apply">BECOME A RESELLER <ArrowRight size={15} /></Link><Link className="btn-ghost" href="/how-reselling-works">How it works</Link></div>
          </div>
          <div className="feature-panel">
            <span className="eyebrow" style={{ color: 'hsl(var(--accent))' }}>The reseller opportunity</span>
            <h3 className="display-md" style={{ margin: '28px 0 18px', maxWidth: 440 }}>Your fragrance business, in three steps.</h3>
            <p>Buy at reseller prices, sell at the recommended retail price and keep the margin. Qualifying leaders earn incentives on their team's product sales — never on recruitment or joining fees.</p>
            <div className="story-lines light" style={{ marginTop: 42 }}><div><strong>01</strong><span>Apply & get approved</span></div><div><strong>02</strong><span>{config.data?.openingOrder ?? 10}-bottle opening order</span></div><div><strong>03</strong><span>Sell, share & grow a team</span></div></div>
          </div>
        </div>
      </section>

      {/* 9. About */}
      <section className="section section-tint compact" data-testid="section-about">
        <div className="container-wide split">
          <div><span className="eyebrow">About Mas'Mila</span><h2 className="display-md">Scent belongs to everyone.</h2></div>
          <div><p className="body-lg">Not saved for special occasions. Not hidden behind a glass counter. Mas'Mila makes long-lasting fragrance that moves with real South African lives — and a business model that does too.</p>
            <div className="hero-actions"><Link className="btn-ink" href="/our-story">Read our story <ArrowRight size={15} /></Link><Link className="btn-ghost" href="/corporate"><Gift size={15} /> Corporate gifts</Link></div>
          </div>
        </div>
      </section>

      {/* 10. Testimonials */}
      <section className="section" data-testid="section-testimonials">
        <div className="container-wide">
          <div className="section-head"><div><span className="eyebrow">In their words</span><h2 className="display-md">Customers & resellers</h2></div></div>
          <div className="testimonial-grid scroller">{(home.data?.testimonials ?? []).map((t) => (
            <figure key={t.name} className="testimonial"><div className="testimonial-top"><Quote size={18} /><Stars /></div><blockquote>{t.quote}</blockquote><figcaption><span className="avatar" aria-hidden="true">{t.name.charAt(0)}</span><span><strong>{t.name}</strong>{t.location}</span></figcaption></figure>
          ))}</div>
        </div>
      </section>

      {/* 11. Social feed */}
      <section className="section section-tint compact" data-testid="section-social">
        <div className="container-wide">
          <div className="section-head"><div><span className="eyebrow">@masmilafragrances</span><h2 className="display-md">Follow the scent trail</h2></div><div className="share-row">
            {c.instagramUrl ? <a className="btn-ghost small" href={c.instagramUrl} target="_blank" rel="noreferrer"><Instagram size={14} /> Instagram</a> : null}
            {c.tiktokUrl ? <a className="btn-ghost small" href={c.tiktokUrl} target="_blank" rel="noreferrer"><Music2 size={14} /> TikTok</a> : null}
            {c.facebookUrl ? <a className="btn-ghost small" href={c.facebookUrl} target="_blank" rel="noreferrer"><Facebook size={14} /> Facebook</a> : null}
          </div></div>
          <div className="social-grid">{[...(home.data?.featured ?? []), ...(home.data?.newArrivals ?? []), ...(home.data?.bestSellers ?? [])]
            .filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i)
            .slice(0, 6)
            .map((p) => (
            <a key={p.id} href={c.instagramUrl ?? '#'} target="_blank" rel="noreferrer" className="social-tile" aria-label={`${p.name} on Instagram`}><img src={imageFor(p)} alt={p.imageAlt} loading="lazy" /><span><Instagram size={18} /></span></a>
          ))}</div>
        </div>
      </section>

      {/* 12. WhatsApp / newsletter opt-in */}
      <section className="section" data-testid="section-optin">
        <div className="container-wide optin-card">
          <div>
            <span className="eyebrow">Stay in the loop</span>
            <h2 className="display-md">Launches, restocks & offers — straight to WhatsApp.</h2>
            <p className="body-lg">Join the list, or chat to us for help choosing the right scent or gift.</p>
            <div className="hero-actions">
              <Link className="btn-primary" href="/shop">ORDER VIA WEBSITE <ArrowRight size={15} /></Link>
              {config.data?.whatsappNumber ? <a className="btn-ghost" href={whatsappLink(config.data.whatsappNumber, "Hi Mas'Mila, I'd like help choosing a fragrance.")} target="_blank" rel="noreferrer"><WhatsAppIcon size={15} /> CHAT ON WHATSAPP</a> : null}
            </div>
          </div>
          <Newsletter light defaultChannel="whatsapp" />
        </div>
      </section>
    </main>
  );
}
