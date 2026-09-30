import type { Product } from "@workspace/db";

export type StockStatus = "in_stock" | "low_stock" | "out_of_stock";

export const available = (p: Pick<Product, "stockQuantity" | "reservedQuantity">) =>
  Math.max(0, p.stockQuantity - p.reservedQuantity);

export function stockStatus(p: Product): StockStatus {
  const left = available(p);
  if (left <= 0) return "out_of_stock";
  if (left <= p.lowStockThreshold) return "low_stock";
  return "in_stock";
}

function badgeFor(p: Product) {
  const status = stockStatus(p);
  if (status === "out_of_stock") return "Sold out";
  if (p.isNew) return "New";
  if (p.isBestSeller) return "Best seller";
  if (status === "low_stock") return "Almost gone";
  return null;
}

/**
 * Public product shape. Internal cost is never included; the reseller price
 * only when the caller is an approved reseller.
 */
export function toPublicProduct(p: Product, showResellerPrice: boolean) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    sku: p.sku,
    family: p.family,
    category: p.category,
    size: p.size,
    price: p.retailPrice,
    recommendedRetailPrice: p.recommendedRetailPrice,
    resellerPrice: showResellerPrice ? p.resellerPrice : null,
    image: p.image,
    imageAlt: p.imageAlt || `${p.name} ${p.size} ${p.family.toLowerCase()} ${p.category.toLowerCase()} fragrance by Mas'Mila`,
    notes: [p.topNotes[0], p.middleNotes[0], p.baseNotes[0]].filter((n): n is string => Boolean(n)),
    badge: badgeFor(p),
    isBestSeller: p.isBestSeller,
    isNew: p.isNew,
    stockStatus: stockStatus(p),
  };
}

export function toProductDetail(p: Product, showResellerPrice: boolean, related: Product[]) {
  return {
    ...toPublicProduct(p, showResellerPrice),
    description: p.description,
    scentProfile: p.scentProfile,
    topNotes: p.topNotes,
    middleNotes: p.middleNotes,
    baseNotes: p.baseNotes,
    seoTitle: p.seoTitle || `${p.name} ${p.size} ${p.category} Perfume | Mas'Mila Fragrances South Africa`,
    seoDescription:
      p.seoDescription ||
      `${p.name} — a ${p.family.toLowerCase()} ${p.category.toLowerCase()} fragrance (${p.size}) with ${[...p.topNotes, ...p.baseNotes].slice(0, 3).join(", ").toLowerCase()}. Affordable South African perfume, delivered nationwide.`,
    related: related.map((r) => toPublicProduct(r, showResellerPrice)),
  };
}

export const CATEGORIES = ["Women's", "Men's", "Unisex"];
export const FAMILIES = ["Floral", "Fresh", "Fruity", "Woody", "Oriental", "Sweet", "Citrus"];

/**
 * Stock photos seeded by earlier versions. Some showed other brands' bottles,
 * so they are cleared on startup; the storefront renders branded artwork for
 * products without an uploaded photo.
 */
export const LEGACY_PLACEHOLDER_IMAGES = [
  "https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1615634260167-c8cdede054de?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1588405748880-12d1d2a59f75?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1523293182086-7651a899d37f?auto=format&fit=crop&w=900&q=85",
];

type SeedScent = {
  code: string;
  name: string;
  category: string;
  family: string;
  profile: string;
  top: string[];
  middle: string[];
  base: string[];
  bestSeller?: boolean;
  isNew?: boolean;
  featured?: boolean;
};

const SCENTS: SeedScent[] = [
  { code: "VB", name: "Velvet Bloom", category: "Women's", family: "Floral", profile: "Soft, romantic and powdery", top: ["Pink pepper", "Pear"], middle: ["Peony", "Rose"], base: ["Soft musk", "Cashmere wood"], bestSeller: true, featured: true },
  { code: "SO", name: "Solaris", category: "Unisex", family: "Citrus", profile: "Bright, sunlit and clean", top: ["Bergamot", "Mandarin"], middle: ["Neroli", "Orange blossom"], base: ["Cedar", "White musk"], isNew: true, featured: true },
  { code: "AD", name: "After Dark", category: "Men's", family: "Oriental", profile: "Spiced, warm and magnetic", top: ["Black pepper", "Cardamom"], middle: ["Leather", "Iris"], base: ["Amber", "Vanilla"], bestSeller: true, featured: true },
  { code: "GH", name: "Golden Hour", category: "Unisex", family: "Woody", profile: "Creamy woods at sunset", top: ["Fig leaf", "Bergamot"], middle: ["Jasmine", "Orris"], base: ["Sandalwood", "Tonka"], featured: true },
  { code: "PI", name: "Pure Intention", category: "Women's", family: "Fresh", profile: "Clean linen and white tea", top: ["Lemon", "Aldehydes"], middle: ["White tea", "Lily of the valley"], base: ["Musk", "Ambrette"] },
  { code: "NW", name: "Noir Woods", category: "Men's", family: "Woody", profile: "Dark, smoky and refined", top: ["Cardamom", "Grapefruit"], middle: ["Vetiver", "Cypress"], base: ["Oakmoss", "Oud accord"], bestSeller: true },
  { code: "SB", name: "Sugar Bloom", category: "Women's", family: "Sweet", profile: "Playful gourmand", top: ["Red berries", "Mandarin"], middle: ["Caramel", "Jasmine"], base: ["Vanilla", "Praline"], bestSeller: true },
  { code: "OA", name: "Ocean Air", category: "Men's", family: "Fresh", profile: "Aquatic and energising", top: ["Sea salt", "Lime"], middle: ["Lavender", "Geranium"], base: ["Driftwood", "Ambergris"] },
  { code: "MG", name: "Marula Glow", category: "Women's", family: "Fruity", profile: "Juicy, sun-ripened fruit", top: ["Marula", "Passion fruit"], middle: ["Frangipani", "Peach"], base: ["Coconut", "Musk"], isNew: true },
  { code: "KS", name: "Karoo Sky", category: "Unisex", family: "Woody", profile: "Dry, open and earthy", top: ["Rooibos", "Juniper"], middle: ["Sage", "Clary sage"], base: ["Cedarwood", "Vetiver"], isNew: true },
  { code: "RQ", name: "Royal Oud", category: "Men's", family: "Oriental", profile: "Opulent and resinous", top: ["Saffron", "Nutmeg"], middle: ["Rose", "Oud"], base: ["Patchouli", "Benzoin"] },
  { code: "CL", name: "Citrus Lane", category: "Unisex", family: "Citrus", profile: "Zesty and effervescent", top: ["Lemon", "Grapefruit"], middle: ["Petitgrain", "Basil"], base: ["Vetiver", "Musk"] },
  { code: "MR", name: "Midnight Rose", category: "Women's", family: "Floral", profile: "Deep rose after dark", top: ["Blackcurrant", "Raspberry"], middle: ["Turkish rose", "Violet"], base: ["Patchouli", "Amber"], bestSeller: true },
  { code: "BL", name: "Bold Legacy", category: "Men's", family: "Woody", profile: "Confident boardroom woods", top: ["Apple", "Bergamot"], middle: ["Pineapple", "Birch"], base: ["Oakmoss", "Musk"], bestSeller: true },
  { code: "SV", name: "Soft Vanilla", category: "Women's", family: "Sweet", profile: "Warm vanilla skin scent", top: ["Pear", "Almond"], middle: ["Heliotrope", "Orchid"], base: ["Madagascar vanilla", "Sandalwood"] },
  { code: "TP", name: "Tropic Punch", category: "Unisex", family: "Fruity", profile: "Holiday in a bottle", top: ["Mango", "Pineapple"], middle: ["Coconut water", "Tiare"], base: ["Musk", "Driftwood"], isNew: true },
  { code: "AM", name: "Amber Nights", category: "Unisex", family: "Oriental", profile: "Glowing amber and spice", top: ["Cinnamon", "Orange"], middle: ["Labdanum", "Clove"], base: ["Amber", "Tonka"] },
  { code: "FG", name: "Fresh Grace", category: "Women's", family: "Fresh", profile: "Green, dewy and airy", top: ["Cucumber", "Green tea"], middle: ["Lotus", "Freesia"], base: ["White musk", "Cedar"] },
  { code: "EV", name: "Evergreen", category: "Men's", family: "Fresh", profile: "Crisp forest morning", top: ["Pine", "Mint"], middle: ["Lavender", "Rosemary"], base: ["Fir balsam", "Musk"] },
  { code: "JB", name: "Jacaranda", category: "Women's", family: "Floral", profile: "Pretoria spring in bloom", top: ["Violet leaf", "Bergamot"], middle: ["Jacaranda accord", "Iris"], base: ["Musk", "Cedar"], isNew: true, featured: true },
  { code: "CH", name: "Cherry Kiss", category: "Women's", family: "Fruity", profile: "Glossy cherry and almond", top: ["Black cherry", "Bitter almond"], middle: ["Rose", "Jasmine"], base: ["Tonka", "Vanilla"] },
  { code: "LE", name: "Lemon Leaf", category: "Men's", family: "Citrus", profile: "Sharp, green and bright", top: ["Lemon", "Lime"], middle: ["Ginger", "Neroli"], base: ["Vetiver", "Oakmoss"] },
  { code: "HN", name: "Honey Noir", category: "Unisex", family: "Sweet", profile: "Smoky honey and tobacco", top: ["Honey", "Bergamot"], middle: ["Tobacco leaf", "Cacao"], base: ["Vanilla", "Oud accord"] },
  { code: "SS", name: "Silk Sands", category: "Unisex", family: "Woody", profile: "Warm skin and sand", top: ["Pink pepper", "Cardamom"], middle: ["Iris", "Ambrette"], base: ["Sandalwood", "Musk"], bestSeller: true },
];

const SIZE_PRICING = {
  "50ml": { retail: 299, reseller: 140, cost: 68, stock: 60 },
  "100ml": { retail: 449, reseller: 210, cost: 102, stock: 40 },
} as const;

export function seedProducts() {
  return SCENTS.flatMap((scent, index) =>
    (["50ml", "100ml"] as const).map((size) => {
      const pricing = SIZE_PRICING[size];
      const sku = `MM-${scent.code}-${size === "50ml" ? "50" : "100"}`;
      const notes = [...scent.top, ...scent.middle, ...scent.base];
      return {
        slug: `${scent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${size}`,
        sku,
        name: scent.name,
        category: scent.category,
        family: scent.family,
        scentProfile: scent.profile,
        description: `${scent.name} is a ${scent.profile.toLowerCase()} ${scent.family.toLowerCase()} fragrance. It opens with ${scent.top.join(" and ").toLowerCase()}, settles into a heart of ${scent.middle.join(" and ").toLowerCase()}, and dries down to ${scent.base.join(" and ").toLowerCase()}. Long-lasting eau de parfum made for everyday wear and easy gifting.`,
        topNotes: scent.top,
        middleNotes: scent.middle,
        baseNotes: scent.base,
        keywords: `${notes.join(" ")} ${scent.family} ${scent.category} perfume gift`.toLowerCase(),
        image: "",
        imageAlt: `${scent.name} ${size} ${scent.family.toLowerCase()} ${scent.category.toLowerCase()} perfume bottle by Mas'Mila`,
        size,
        retailPrice: pricing.retail,
        recommendedRetailPrice: pricing.retail,
        resellerPrice: pricing.reseller,
        cost: pricing.cost,
        stockQuantity: pricing.stock + ((index * 7) % 25),
        lowStockThreshold: 10,
        isBestSeller: Boolean(scent.bestSeller),
        isNew: Boolean(scent.isNew),
        isFeatured: Boolean(scent.featured) && size === "50ml",
        status: "active",
      };
    }),
  );
}

export const DEFAULT_SITE_CONTENT: Record<string, string> = {
  announcement: "Free delivery on orders over R750 · Nationwide courier across South Africa",
  heroEyebrow: "South African fragrance, made personal",
  heroTitle: "Wear the fragrance. Build the business.",
  heroSubtitle: "Long-lasting 50ml and 100ml fragrances with enough point of view to become yours — and a reseller opportunity that rewards real product sales.",
  brandIntro: "Mas'Mila is a South African fragrance house making beautiful, affordable scent for everyday main characters — and opening the door for ambitious people to build a fragrance business of their own.",
  resellerPitch: "Start with a 10-bottle opening order, sell at the recommended retail price and keep the margin. Grow a team and earn leadership incentives on real product sales — never on recruitment.",
  whatsappNumber: "27710000000",
  contactEmail: "hello@masmila.co.za",
  contactPhone: "+27 71 000 0000",
  bankDetails: "Mas'Mila Fragrances (Pty) Ltd · FNB · Account 000 000 0000 · Branch 250655 · Use your order number as the reference.",
  instagramUrl: "https://instagram.com/masmilafragrances",
  facebookUrl: "https://facebook.com/masmilafragrances",
  tiktokUrl: "https://tiktok.com/@masmilafragrances",
};

export const TESTIMONIALS = [
  { name: "Palesa M.", location: "Soweto", quote: "Velvet Bloom lasts all day and I get asked what I'm wearing every single time." },
  { name: "Andile K.", location: "Durban", quote: "After Dark smells like something three times the price. It's my signature now." },
  { name: "Nomdade S.", location: "Pretoria · Reseller", quote: "I started with ten bottles and a WhatsApp status. Six months later I'm leading my own team." },
  { name: "Lauren v.d. M.", location: "Cape Town", quote: "Beautiful gifts, fast delivery and the 100ml is such good value." },
];

export const DEFAULT_MARKETING = [
  { title: "Product photography pack", category: "product_images", url: "https://drive.google.com/masmila/product-images", description: "High-resolution bottle shots for every fragrance, on white and lifestyle backgrounds.", minRank: "reseller" },
  { title: "Fragrance descriptions & notes", category: "descriptions", url: "https://drive.google.com/masmila/descriptions", description: "Copy-ready descriptions and scent notes for WhatsApp and social posts.", minRank: "reseller" },
  { title: "WhatsApp status templates", category: "whatsapp", url: "https://drive.google.com/masmila/whatsapp", description: "Vertical promo images sized for WhatsApp status.", minRank: "reseller" },
  { title: "Current price list", category: "price_list", url: "https://drive.google.com/masmila/price-list", description: "Recommended retail prices to share with customers.", minRank: "reseller" },
  { title: "Full catalogue (PDF)", category: "catalogue", url: "https://drive.google.com/masmila/catalogue", description: "The complete Mas'Mila range with notes and sizes.", minRank: "reseller" },
  { title: "Selling fragrance 101 (video)", category: "video", url: "https://youtube.com/@masmila", description: "How to describe scent families and match customers to a fragrance.", minRank: "reseller" },
  { title: "Team Leader playbook", category: "training", url: "https://drive.google.com/masmila/team-leader-playbook", description: "Onboarding new resellers, weekly check-ins and supporting inactive members.", minRank: "team_leader" },
  { title: "Team launch campaign kit", category: "campaign", url: "https://drive.google.com/masmila/team-campaign", description: "Co-branded launch graphics for team events.", minRank: "team_leader" },
];
