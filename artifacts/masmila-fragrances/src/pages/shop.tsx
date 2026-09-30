import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Search, Sparkles, X } from 'lucide-react';
import { getListProductsQueryKey, useListProducts, type ListProductsParams } from '@workspace/api-client-react';
import { ErrorState, LoadingGrid, ProductCard } from '@/components/bits';
import { useSeo } from '@/lib/seo';
import { useMe } from '@/lib/auth';
import { track } from '@/lib/analytics';

type Collection = { title: string; eyebrow: string; blurb: string; seo: string; params: ListProductsParams };

/** Collection pages: /shop, /shop/women, /shop/men, /shop/unisex, /shop/new-arrivals, /shop/best-sellers */
const COLLECTIONS: Record<string, Collection> = {
  '': { title: 'All fragrances', eyebrow: 'The collection', blurb: 'Every Mas\'Mila scent in 50ml and 100ml — from clean skin scents to warm, late-night woods.', seo: 'Shop all perfume — 50ml & 100ml fragrances in South Africa', params: {} },
  women: { title: "Women's fragrances", eyebrow: 'For her', blurb: 'Florals, fruity gourmands and fresh everyday scents made to last.', seo: "Women's perfume South Africa — 50ml & 100ml", params: { category: "Women's" } },
  men: { title: "Men's fragrances", eyebrow: 'For him', blurb: 'Woods, spice and fresh aquatic colognes for every day and every occasion.', seo: "Men's perfume & cologne South Africa", params: { category: "Men's" } },
  unisex: { title: 'Unisex fragrances', eyebrow: 'For everyone', blurb: 'Scents without rules — citrus, woods and amber made to share.', seo: 'Unisex perfume South Africa', params: { category: 'Unisex' } },
  'new-arrivals': { title: 'New arrivals', eyebrow: 'Just landed', blurb: 'The newest additions to the Mas\'Mila wardrobe.', seo: 'New perfume arrivals', params: { collection: 'new-arrivals' } },
  'best-sellers': { title: 'Best sellers', eyebrow: 'Most loved', blurb: 'The scents our customers and resellers reorder most.', seo: 'Best-selling affordable perfume in South Africa', params: { collection: 'best-sellers' } },
};

const CATEGORY_FILTERS = [
  { label: "Women's", value: "Women's" },
  { label: "Men's", value: "Men's" },
  { label: 'Unisex', value: 'Unisex' },
];
const FAMILY_FILTERS = ['Floral', 'Fresh', 'Fruity', 'Woody', 'Oriental', 'Sweet', 'Citrus'];

export default function ShopPage({ collection = '' }: { collection?: string }) {
  const config = COLLECTIONS[collection] ?? COLLECTIONS['']!;
  const searchParams = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const [debounced, setDebounced] = useState(search);
  const [family, setFamily] = useState(searchParams.get('family') ?? '');
  const [category, setCategory] = useState('');
  const [size, setSize] = useState('');
  const [sort, setSort] = useState<ListProductsParams['sort']>('featured');
  const { data: me } = useMe();

  useEffect(() => { setFamily(searchParams.get('family') ?? ''); setCategory(''); }, [collection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { if (debounced) track('search', { search_string: debounced }); }, [debounced]);

  const params = useMemo<ListProductsParams>(() => ({
    ...config.params,
    ...(category && !config.params.category ? { category } : {}),
    ...(family ? { family } : {}),
    ...(size ? { size } : {}),
    ...(debounced ? { search: debounced } : {}),
    sort,
    limit: 200,
  }), [config, category, family, size, debounced, sort]);
  const products = useListProducts(params, { query: { queryKey: getListProductsQueryKey(params) } });

  useSeo({
    title: family ? `${family} perfume${config.params.category ? ` · ${config.title}` : ''}` : config.seo,
    description: `${config.blurb} Affordable, long-lasting fragrances and perfume gifts delivered across South Africa.`,
    jsonLd: products.data?.length
      ? { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: products.data.slice(0, 20).map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${window.location.origin}/product/${p.slug}`, name: `${p.name} ${p.size}` })) }
      : null,
  });

  const clear = () => { setSearch(''); setFamily(''); setCategory(''); setSize(''); navigate(collection ? `/shop/${collection}` : '/shop'); };
  const isReseller = Boolean(me?.reseller);

  return (
    <main className="container-wide">
      <div className="page-intro"><span className="eyebrow">{config.eyebrow}</span><h1 className="display-lg">{config.title}</h1><p className="body-lg">{config.blurb}</p>
        {isReseller ? <p className="notice" data-testid="notice-reseller-pricing">Signed in as a reseller — wholesale prices are shown. Switch your bag to <strong>Reseller stock order</strong> at checkout.</p> : null}
      </div>
      <div className="shop-layout">
        <aside className="filter-panel" aria-label="Filters">
          <h3>Collections</h3>
          <div className="filter-list">
            {Object.entries(COLLECTIONS).map(([key, c]) => (
              <button key={key} className={`filter-button ${collection === key ? 'selected' : ''}`} onClick={() => navigate(key ? `/shop/${key}` : '/shop')} data-testid={`button-collection-${key || 'all'}`}>{c.title}</button>
            ))}
          </div>
          {!config.params.category ? (
            <><h3 className="filter-heading">Category</h3><div className="filter-list">
              {CATEGORY_FILTERS.map((f) => <button key={f.value} className={`filter-button ${category === f.value ? 'selected' : ''}`} onClick={() => setCategory(category === f.value ? '' : f.value)} data-testid={`button-filter-${f.label.toLowerCase().replace(/[^a-z]/g, '')}`}>{f.label}</button>)}
            </div></>
          ) : null}
          <h3 className="filter-heading">Fragrance family</h3>
          <div className="filter-list">
            {FAMILY_FILTERS.map((f) => <button key={f} className={`filter-button ${family === f ? 'selected' : ''}`} onClick={() => setFamily(family === f ? '' : f)} data-testid={`button-family-${f.toLowerCase()}`}>{f === 'Oriental' ? 'Oriental / amber' : f}</button>)}
          </div>
          <h3 className="filter-heading">Size</h3>
          <div className="filter-list">
            {['50ml', '100ml'].map((s) => <button key={s} className={`filter-button ${size === s ? 'selected' : ''}`} onClick={() => setSize(size === s ? '' : s)} data-testid={`button-size-${s}`}>{s}</button>)}
          </div>
        </aside>
        <section>
          <div className="search-row">
            <label className="search-box"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, SKU, family or note" aria-label="Search fragrances" data-testid="input-search-products" />{search ? <button className="icon-button" style={{ width: 24, height: 24, border: 0 }} onClick={() => setSearch('')} aria-label="Clear search" data-testid="button-clear-search"><X size={13} /></button> : null}</label>
            <div className="search-tools">
              <select value={sort} onChange={(e) => setSort(e.target.value as ListProductsParams['sort'])} aria-label="Sort products" className="select-plain" data-testid="select-sort">
                <option value="featured">Featured</option><option value="name">Name A–Z</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="newest">Newest</option>
              </select>
              <span className="count-label" data-testid="text-product-count">{products.data?.length ?? 0} results</span>
            </div>
          </div>
          {products.isLoading ? <LoadingGrid count={8} /> : products.error ? <ErrorState error={products.error} onRetry={() => void products.refetch()} /> : products.data?.length ? (
            <div className="product-grid">{products.data.map((p) => <ProductCard key={p.id} product={p} />)}</div>
          ) : (
            <div className="empty-state" data-testid="state-empty-products"><Sparkles size={20} color="hsl(var(--primary))" /><h2>No scent matches that.</h2><p>Try another search, or clear the filters and let your nose lead.</p><button className="btn-ghost" onClick={clear} data-testid="button-clear-filters">Clear filters</button></div>
          )}
        </section>
      </div>
    </main>
  );
}
