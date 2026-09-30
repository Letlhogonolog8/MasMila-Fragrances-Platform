import { Router, type IRouter } from "express";
import { db, productsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

const STATIC_PAGES = [
  "", "shop", "shop/women", "shop/men", "shop/unisex", "shop/new-arrivals", "shop/best-sellers",
  "about", "our-story", "become-a-reseller", "how-reselling-works", "corporate", "contact", "faqs",
  "shipping", "returns", "privacy", "terms", "reseller-terms", "cookies", "track-order",
];

const escapeXml = (value: string) => value.replace(/[<>&'"]/g, (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" }[c]};`);

/** XML sitemap for Google Search Console (referenced from robots.txt). */
router.get("/sitemap.xml", async (_req, res) => {
  const base = (process.env.SITE_URL ?? "https://masmila.co.za").replace(/\/$/, "");
  const products = await db.select({ slug: productsTable.slug, updatedAt: productsTable.updatedAt }).from(productsTable).where(eq(productsTable.status, "active"));
  const urls = [
    ...STATIC_PAGES.map((path) => `<url><loc>${escapeXml(`${base}/${path}`)}</loc><changefreq>weekly</changefreq><priority>${path === "" ? "1.0" : "0.7"}</priority></url>`),
    ...products.map((p) => `<url><loc>${escapeXml(`${base}/product/${p.slug}`)}</loc><lastmod>${p.updatedAt.toISOString().slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`),
  ];
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`);
});

export default router;
