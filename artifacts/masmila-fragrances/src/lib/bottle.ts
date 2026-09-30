/**
 * Branded bottle artwork used until real product photography is uploaded.
 * Each fragrance family has its own palette so the catalogue reads at a
 * glance, and every bottle carries the scent's own name — no stock photos of
 * other brands' products.
 */
type Palette = { bg: string; glow: string; from: string; to: string; label: string; ink: string };

const PALETTES: Record<string, Palette> = {
  Floral: { bg: '#f3dcd8', glow: '#fbe7b5', from: '#b94a63', to: '#e5889a', label: '#fff4e3', ink: '#3b2330' },
  Fresh: { bg: '#d9ece6', glow: '#f2f7c9', from: '#2f8a7b', to: '#78c4b1', label: '#f7fbf5', ink: '#173a35' },
  Fruity: { bg: '#f7dccb', glow: '#fde9a8', from: '#d8572f', to: '#f39a5c', label: '#fff6e8', ink: '#3d2016' },
  Woody: { bg: '#e6d2b3', glow: '#f1e3a4', from: '#6e4226', to: '#a8703f', label: '#f8efdc', ink: '#2e1d12' },
  Oriental: { bg: '#ebcfa9', glow: '#dade46', from: '#8a2b27', to: '#c9553b', label: '#fbf0d9', ink: '#34191a' },
  Sweet: { bg: '#f4e0e8', glow: '#fbe3c4', from: '#a9507f', to: '#dc92b6', label: '#fff4f8', ink: '#3a1f2d' },
  Citrus: { bg: '#f5ecbd', glow: '#ffffff', from: '#cf8f12', to: '#f0c43f', label: '#fffbea', ink: '#3b2a07' },
};
const FALLBACK = PALETTES.Oriental!;

const escapeXml = (value: string) => value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function bottleSvg(name: string, size: string, family: string) {
  const p = PALETTES[family] ?? FALLBACK;
  const large = size.startsWith('100');
  const w = large ? 176 : 150;
  const h = large ? 250 : 214;
  const x = (400 - w) / 2;
  const y = 440 - h;
  const cap = { w: w * 0.5, h: large ? 58 : 52 };
  const label = name.length > 9 ? 19 : 23;
  // Squeeze long names to the label width instead of letting them overflow.
  const labelWidth = w - 40;
  const fit = name.length > 9 ? ` textLength="${labelWidth}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 488">
<defs>
<linearGradient id="b" x1="0" x2="1"><stop offset="0" stop-color="${p.from}"/><stop offset=".55" stop-color="${p.to}"/><stop offset="1" stop-color="${p.from}"/></linearGradient>
<linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="400" height="488" fill="${p.bg}"/>
<circle cx="200" cy="170" r="150" fill="${p.glow}" opacity=".75"/>
<ellipse cx="206" cy="448" rx="${w * 0.72}" ry="14" fill="#000" opacity=".12"/>
<rect x="${(400 - cap.w) / 2}" y="${y - cap.h + 6}" width="${cap.w}" height="${cap.h}" rx="6" fill="#2f2528"/>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="url(#b)"/>
<rect x="${x + 14}" y="${y + 12}" width="18" height="${h - 24}" rx="9" fill="url(#s)"/>
<rect x="${x + 12}" y="${y + h * 0.36}" width="${w - 24}" height="${large ? 92 : 84}" rx="4" fill="${p.label}"/>
<text x="200" y="${y + h * 0.36 + 24}" text-anchor="middle" font-family="DM Mono, monospace" font-size="11" letter-spacing="3" fill="${p.ink}" opacity=".7">MAS'MILA</text>
<text x="200" y="${y + h * 0.36 + 52}" text-anchor="middle" font-family="Fraunces, Georgia, serif" font-weight="600" font-size="${label}" fill="${p.ink}"${fit}>${escapeXml(name)}</text>
<text x="200" y="${y + h * 0.36 + (large ? 76 : 70)}" text-anchor="middle" font-family="DM Mono, monospace" font-size="11" letter-spacing="2" fill="${p.ink}" opacity=".75">${escapeXml(size.toUpperCase())} · EDP</text>
</svg>`;
}

const cache = new Map<string, string>();

type ProductLike = { image?: string | null; name: string; size: string; family: string };

/** Generated bottle artwork (also the fallback if a photo fails to load). */
export function artworkFor(p: ProductLike) {
  const key = `${p.name}|${p.size}|${p.family}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bottleSvg(p.name, p.size, p.family))}`;
    cache.set(key, uri);
  }
  return uri;
}

/**
 * TEMPORARY placeholder photography until the client supplies product photos.
 * An image uploaded in Admin → Products always takes precedence.
 *
 *  - 'brands'   Well-known designer fragrances (Chanel, Dior, Lancôme, Armani).
 *               FOR PRIVATE CLIENT DEMOS ONLY — other companies' trademarks;
 *               switch away from this before the site goes public.
 *  - 'neutral'  Brand-free stock photos (blank labels, generic bottles).
 *  - 'artwork'  Generated Mas'Mila bottle artwork, no photos.
 */
const PLACEHOLDER_SET: 'brands' | 'neutral' | 'artwork' = 'brands';

const unsplash = (id: string) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=640&h=780&q=75`;

const BRAND = {
  missDior: unsplash('photo-1458538977777-0549b2370168'),
  cocoNoir: unsplash('photo-1594035910387-fea47794261f'),
  cocoMademoiselle: unsplash('photo-1592945403244-b3fbafd7f539'),
  chanelNo5: unsplash('photo-1541643600914-78b084683601'),
  gabrielle: unsplash('photo-1588405748880-12d1d2a59f75'),
  bleuDeChanel: unsplash('photo-1523293182086-7651a899d37f'),
  bleuStyle: unsplash('photo-1553699357-fdefb876c402'),
  laVieEstBelle: unsplash('photo-1613521140785-e85e427f8002'),
  armaniSi: unsplash('photo-1693960794637-42e1cf5baa0b'),
  designerCollection: unsplash('photo-1615634260167-c8cdede054de'),
};

/** Brand demo set, hand-spread so scents shown side by side differ. */
const BRAND_BY_SCENT: Record<string, string> = {
  'Velvet Bloom': BRAND.missDior, 'Midnight Rose': BRAND.cocoNoir, Jacaranda: BRAND.laVieEstBelle,
  'Sugar Bloom': BRAND.cocoMademoiselle, 'Soft Vanilla': BRAND.chanelNo5, 'Honey Noir': BRAND.gabrielle,
  'Marula Glow': BRAND.armaniSi, 'Tropic Punch': BRAND.designerCollection, 'Cherry Kiss': BRAND.laVieEstBelle,
  'Pure Intention': BRAND.chanelNo5, 'Ocean Air': BRAND.bleuDeChanel, 'Fresh Grace': BRAND.missDior, Evergreen: BRAND.bleuStyle,
  Solaris: BRAND.gabrielle, 'Citrus Lane': BRAND.designerCollection, 'Lemon Leaf': BRAND.chanelNo5,
  'Golden Hour': BRAND.designerCollection, 'Noir Woods': BRAND.designerCollection, 'Karoo Sky': BRAND.bleuDeChanel,
  'Bold Legacy': BRAND.bleuDeChanel, 'Silk Sands': BRAND.cocoMademoiselle,
  'After Dark': BRAND.bleuStyle, 'Royal Oud': BRAND.cocoNoir, 'Amber Nights': BRAND.gabrielle,
};
const BRAND_BY_FAMILY: Record<string, string[]> = {
  Floral: [BRAND.missDior, BRAND.laVieEstBelle, BRAND.cocoNoir],
  Sweet: [BRAND.cocoMademoiselle, BRAND.chanelNo5],
  Fruity: [BRAND.armaniSi, BRAND.laVieEstBelle],
  Fresh: [BRAND.chanelNo5, BRAND.bleuDeChanel],
  Citrus: [BRAND.gabrielle, BRAND.designerCollection],
  Woody: [BRAND.bleuStyle, BRAND.designerCollection],
  Oriental: [BRAND.cocoNoir, BRAND.bleuStyle],
};

const PHOTO = {
  whiteSilk: unsplash('photo-1571206508927-2ef3026ada5d'),
  blankLabelGroup: unsplash('photo-1718466044521-d38654f3ba0a'),
  blankLabelStones: unsplash('photo-1705899844877-81bb0a0665c1'),
  redGlass: unsplash('photo-1720423738890-37689a6f6b95'),
  clearGlass: unsplash('photo-1720423514789-15a33e59fc81'),
  amber: unsplash('photo-1638295916768-459f6cf440bc'),
  blackPodium: unsplash('photo-1647507653704-bde7f2d6dbf0'),
};
const PHOTOS_BY_FAMILY: Record<string, string[]> = {
  Floral: [PHOTO.whiteSilk, PHOTO.blankLabelGroup],
  Sweet: [PHOTO.whiteSilk, PHOTO.blankLabelStones],
  Fruity: [PHOTO.redGlass, PHOTO.blankLabelGroup],
  Fresh: [PHOTO.clearGlass, PHOTO.blankLabelStones],
  Citrus: [PHOTO.amber, PHOTO.clearGlass],
  Woody: [PHOTO.blackPodium, PHOTO.amber],
  Oriental: [PHOTO.redGlass, PHOTO.blackPodium],
};
const ALL_PHOTOS = Object.values(PHOTO);

/** Hand-spread over the seeded catalogue so scents shown side by side differ. */
const PHOTO_BY_SCENT: Record<string, string> = {
  'Velvet Bloom': PHOTO.whiteSilk, 'Midnight Rose': PHOTO.redGlass, Jacaranda: PHOTO.blankLabelGroup,
  'Sugar Bloom': PHOTO.blankLabelStones, 'Soft Vanilla': PHOTO.whiteSilk, 'Honey Noir': PHOTO.amber,
  'Marula Glow': PHOTO.redGlass, 'Tropic Punch': PHOTO.amber, 'Cherry Kiss': PHOTO.blankLabelGroup,
  'Pure Intention': PHOTO.clearGlass, 'Ocean Air': PHOTO.blankLabelStones, 'Fresh Grace': PHOTO.whiteSilk, Evergreen: PHOTO.clearGlass,
  Solaris: PHOTO.amber, 'Citrus Lane': PHOTO.clearGlass, 'Lemon Leaf': PHOTO.blankLabelStones,
  'Golden Hour': PHOTO.blankLabelGroup, 'Noir Woods': PHOTO.clearGlass, 'Karoo Sky': PHOTO.blankLabelStones,
  'Bold Legacy': PHOTO.redGlass, 'Silk Sands': PHOTO.whiteSilk,
  'After Dark': PHOTO.blackPodium, 'Royal Oud': PHOTO.redGlass, 'Amber Nights': PHOTO.amber,
};

function placeholderPhoto(p: ProductLike, byScent: Record<string, string>, byFamily: Record<string, string[]>, all: string[]) {
  const assigned = byScent[p.name];
  if (assigned) return assigned;
  const pool = byFamily[p.family] ?? all;
  // Same scent → same photo in both sizes; different scents rotate through the pool.
  let hash = 0;
  for (const ch of p.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[hash % pool.length]!;
}

/** The uploaded product photo, else the active placeholder set. */
export function imageFor(p: ProductLike) {
  if (p.image) return p.image;
  if (PLACEHOLDER_SET === 'brands') return placeholderPhoto(p, BRAND_BY_SCENT, BRAND_BY_FAMILY, Object.values(BRAND));
  if (PLACEHOLDER_SET === 'neutral') return placeholderPhoto(p, PHOTO_BY_SCENT, PHOTOS_BY_FAMILY, ALL_PHOTOS);
  return artworkFor(p);
}

export const FAMILY_SWATCH: Record<string, string> = Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, v.to]));
