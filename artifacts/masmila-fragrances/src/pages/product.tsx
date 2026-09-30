import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, MessageCircle, Minus, Plus } from 'lucide-react';
import { getGetProductQueryKey, useGetProduct } from '@workspace/api-client-react';
import { ErrorState, LoadingBlock, PriceBlock, ProductCard, ProductVisual, ShareButtons, WishlistButton } from '@/components/bits';
import { useStoreConfig, whatsappLink } from '@/components/site';
import { useCart } from '@/lib/cart';
import { useSeo } from '@/lib/seo';
import { track } from '@/lib/analytics';
import { money } from '@/lib/format';
import { getReferral, referralUrl } from '@/lib/referral';
import { useMe } from '@/lib/auth';

export default function ProductPage({ slug }: { slug: string }) {
  const product = useGetProduct(slug, { query: { queryKey: getGetProductQueryKey(slug) } });
  const cart = useCart();
  const config = useStoreConfig();
  const { data: me } = useMe();
  const [qty, setQty] = useState(1);
  const p = product.data;

  useEffect(() => {
    if (p) track('view_item', { id: p.sku, name: p.name, price: p.price, category: p.category });
  }, [p]);

  useSeo({
    title: p?.seoTitle ?? 'Fragrance',
    description: p?.seoDescription,
    image: p?.image || undefined,
    jsonLd: p
      ? {
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: `${p.name} ${p.size}`,
          sku: p.sku,
          image: p.image || undefined,
          description: p.description,
          category: `${p.category} fragrance`,
          brand: { '@type': 'Brand', name: "Mas'Mila" },
          offers: {
            '@type': 'Offer',
            priceCurrency: 'ZAR',
            price: p.price.toFixed(2),
            availability: p.stockStatus === 'out_of_stock' ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
            url: `${window.location.origin}/product/${p.slug}`,
            itemCondition: 'https://schema.org/NewCondition',
          },
        }
      : null,
  });

  if (product.isLoading) return <main className="container-wide dashboard-wrap"><LoadingBlock label="Loading fragrance" /></main>;
  if (product.error || !p) return <main className="container-wide dashboard-wrap"><ErrorState error={product.error} title="We couldn't find that fragrance." /><p style={{ textAlign: 'center' }}><Link className="btn-ghost" href="/shop">Back to the shop</Link></p></main>;

  // Resellers share their referral link so the sale is attributed to them.
  const shareUrl = me?.reseller
    ? `${referralUrl(me.reseller.referralCode)}?next=/product/${p.slug}`
    : `${window.location.origin}/product/${p.slug}${getReferral() ? `?ref=${getReferral()!.code}` : ''}`;
  const soldOut = p.stockStatus === 'out_of_stock';
  return (
    <main className="container-wide">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/shop">Shop</Link> / <Link href={`/shop/${p.category.startsWith('W') ? 'women' : p.category.startsWith('M') ? 'men' : 'unisex'}`}>{p.category}</Link> / <span>{p.name}</span></nav>
      <div className="product-detail">
        <ProductVisual product={p} />
        <div className="product-detail-info">
          <span className="eyebrow">{p.family} · {p.category} · SKU {p.sku}</span>
          <h1 className="display-lg" data-testid="text-product-title">{p.name}</h1>
          <p className="scent-profile">{p.scentProfile} · {p.size} eau de parfum</p>
          <div className="detail-price"><PriceBlock product={p} />{p.recommendedRetailPrice > p.price ? <span className="muted">RRP {money(p.recommendedRetailPrice)}</span> : null}</div>
          <p className={`stock stock-${p.stockStatus}`}>{p.stockStatus === 'in_stock' ? 'In stock · ships in 1–2 business days' : p.stockStatus === 'low_stock' ? 'Almost gone — low stock' : 'Sold out'}</p>
          <p className="body-lg">{p.description}</p>
          <dl className="notes-table">
            <div><dt>Top notes</dt><dd>{p.topNotes.join(', ')}</dd></div>
            <div><dt>Heart notes</dt><dd>{p.middleNotes.join(', ')}</dd></div>
            <div><dt>Base notes</dt><dd>{p.baseNotes.join(', ')}</dd></div>
          </dl>
          <div className="buy-row">
            <div className="qty" aria-label="Quantity">
              <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease quantity"><Minus size={14} /></button>
              <span data-testid="text-qty">{qty}</span>
              <button type="button" onClick={() => setQty(Math.min(500, qty + 1))} aria-label="Increase quantity"><Plus size={14} /></button>
            </div>
            <button className="btn-primary grow" disabled={soldOut} onClick={() => cart.add(p, qty)} data-testid="button-add-to-bag">{soldOut ? 'Sold out' : <>Add to bag <ArrowRight size={15} /></>}</button>
          </div>
          {cart.lastAdded?.productId === p.id ? <p className="notice">Added to your bag. <Link href="/cart">View bag & checkout →</Link></p> : null}
          <div className="share-row">
            <WishlistButton productId={p.id} />
            {config.data?.whatsappNumber ? <a className="btn-ghost" href={whatsappLink(config.data.whatsappNumber, `Hi Mas'Mila, I'd like to order ${p.name} ${p.size} (${p.sku}).`)} target="_blank" rel="noreferrer" data-testid="link-order-whatsapp"><MessageCircle size={15} /> Ask on WhatsApp</a> : null}
          </div>
          <div className="share-block"><span className="eyebrow">Share this product</span><ShareButtons url={shareUrl} text={`${p.name} ${p.size} by Mas'Mila — ${p.scentProfile.toLowerCase()}.`} /></div>
        </div>
      </div>
      {p.related.length ? (
        <section className="section"><div className="section-head"><div><span className="eyebrow">You may also like</span><h2 className="display-md">More in {p.family}</h2></div></div><div className="product-grid">{p.related.map((r) => <ProductCard key={r.id} product={r} />)}</div></section>
      ) : null}
    </main>
  );
}
