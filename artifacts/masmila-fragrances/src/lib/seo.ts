import { useEffect } from 'react';

const SITE = "Mas'Mila Fragrances";
const DEFAULT_DESCRIPTION =
  "Affordable, long-lasting 50ml and 100ml perfume from South Africa. Shop women's, men's and unisex fragrances and perfume gifts — or start a perfume business as a Mas'Mila reseller.";

function setMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Per-page SEO title, meta description, Open Graph, canonical URL and JSON-LD. */
export function useSeo(options: { title: string; description?: string; image?: string; jsonLd?: object | null; noindex?: boolean }) {
  const { title, description = DEFAULT_DESCRIPTION, image, jsonLd, noindex } = options;
  const jsonLdText = jsonLd ? JSON.stringify(jsonLd) : null;
  useEffect(() => {
    const fullTitle = title.includes("Mas'Mila") ? title : `${title} | ${SITE}`;
    document.title = fullTitle;
    setMeta('name', 'description', description);
    setMeta('property', 'og:title', fullTitle);
    setMeta('property', 'og:description', description);
    setMeta('property', 'og:type', jsonLdText?.includes('"Product"') ? 'product' : 'website');
    setMeta('property', 'og:url', window.location.href.split('?')[0]!);
    if (image) setMeta('property', 'og:image', image);
    setMeta('name', 'twitter:title', fullTitle);
    setMeta('name', 'twitter:description', description);
    setMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = window.location.href.split('?')[0]!;

    const existing = document.getElementById('page-jsonld');
    existing?.remove();
    if (jsonLdText) {
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = 'page-jsonld';
      script.textContent = jsonLdText;
      document.head.appendChild(script);
    }
  }, [title, description, image, jsonLdText, noindex]);
}

const verification = import.meta.env.VITE_GOOGLE_SITE_VERIFICATION as string | undefined;
if (verification) setMeta('name', 'google-site-verification', verification);
