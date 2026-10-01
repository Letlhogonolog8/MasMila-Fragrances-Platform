import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import {
  GetHomeSummaryResponse,
  GetProductParams,
  GetProductResponse,
  GetReferralQueryParams,
  GetReferralResponse,
  GetStoreConfigResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  SubmitEnquiryBody,
  SubscribeNewsletterBody,
} from "@workspace/api-zod";
import {
  db,
  enquiriesTable,
  newsletterSubscribersTable,
  productsTable,
  referralVisitsTable,
  resellersTable,
  siteContentTable,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { canSeeResellerPricing, authMode } from "../lib/auth";
import { FAMILIES, TESTIMONIALS, toProductDetail, toPublicProduct } from "../lib/catalog";
import { getSettings } from "../lib/settings";
import { notFound } from "../lib/http";
import { notifyAdmins } from "../lib/notify";
import { audit } from "../lib/audit";
import { isShopifyConfigured } from "../lib/shopifyStorefrontClient";

const router: IRouter = Router();

export async function siteContent(): Promise<Record<string, string>> {
  const rows = await db.select().from(siteContentTable);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

router.get("/store-config", async (_req, res) => {
  const [settings, content] = await Promise.all([getSettings(), siteContent()]);
  res.json(
    GetStoreConfigResponse.parse({
      currency: "ZAR",
      shippingFlatRate: settings.shippingFlatRate,
      freeShippingThreshold: settings.freeShippingThreshold,
      openingOrder: settings.openingOrder,
      reorderMinimum: settings.reorderMinimum,
      whatsappNumber: content.whatsappNumber ?? "",
      shopifyCheckoutEnabled: isShopifyConfigured(),
      bankDetails: content.bankDetails ?? "",
      authMode,
      siteUrl: process.env.SITE_URL ?? "https://masmila.co.za",
      bulkDiscountTiers: settings.bulkDiscountTiers,
    }),
  );
});

/** Normalise shop-facing category names ("women", "Women's") to stored values. */
function categoryFilter(value: string): string | null {
  const v = value.toLowerCase().replace(/[^a-z]/g, "");
  if (v.startsWith("wom")) return "Women's";
  if (v.startsWith("men")) return "Men's";
  if (v.startsWith("uni")) return "Unisex";
  return null;
}

router.get("/products", async (req, res) => {
  const query = ListProductsQueryParams.parse(req.query);
  const filters: SQL[] = [eq(productsTable.status, "active")];
  if (query.category) {
    const category = categoryFilter(query.category);
    if (category) filters.push(eq(productsTable.category, category));
    else filters.push(ilike(productsTable.family, query.category.startsWith("Oriental") ? "Oriental" : query.category));
  }
  if (query.family) filters.push(ilike(productsTable.family, query.family.split("/")[0]!.trim()));
  if (query.size) filters.push(eq(productsTable.size, query.size));
  if (query.collection === "best-sellers") filters.push(eq(productsTable.isBestSeller, true));
  if (query.collection === "new-arrivals") filters.push(eq(productsTable.isNew, true));
  if (query.collection === "featured") filters.push(eq(productsTable.isFeatured, true));
  const search = query.search?.trim();
  if (search) {
    // Search by name, SKU, family, category, notes and keywords.
    const words = search.split(/\s+/).slice(0, 6);
    for (const word of words) {
      const like = `%${word.replace(/[%_]/g, "")}%`;
      filters.push(
        or(
          ilike(productsTable.name, like),
          ilike(productsTable.sku, like),
          ilike(productsTable.family, like),
          ilike(productsTable.category, like),
          ilike(productsTable.keywords, like),
          ilike(productsTable.scentProfile, like),
        )!,
      );
    }
  }
  const order =
    query.sort === "price-asc"
      ? [asc(productsTable.retailPrice), asc(productsTable.name)]
      : query.sort === "price-desc"
        ? [desc(productsTable.retailPrice), asc(productsTable.name)]
        : query.sort === "name"
          ? [asc(productsTable.name), asc(productsTable.size)]
          : query.sort === "newest"
            ? [desc(productsTable.createdAt), asc(productsTable.name)]
            : [desc(productsTable.isFeatured), desc(productsTable.isBestSeller), asc(productsTable.name), asc(productsTable.size)];
  const rows = await db
    .select()
    .from(productsTable)
    .where(and(...filters))
    .orderBy(...order)
    .limit(query.limit ?? 48);
  const showReseller = canSeeResellerPricing(req);
  res.json(ListProductsResponse.parse(rows.map((p) => toPublicProduct(p, showReseller))));
});

router.get("/products/:slug", async (req, res) => {
  const { slug } = GetProductParams.parse(req.params);
  const [product] = await db
    .select()
    .from(productsTable)
    .where(and(or(eq(productsTable.slug, slug), eq(productsTable.sku, slug.toUpperCase())), eq(productsTable.status, "active")));
  if (!product) throw notFound("We couldn't find that fragrance.");
  const related = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.status, "active"), ne(productsTable.id, product.id), or(eq(productsTable.name, product.name), eq(productsTable.family, product.family))))
    .orderBy(sql`case when ${productsTable.name} = ${product.name} then 0 else 1 end`, desc(productsTable.isBestSeller))
    .limit(4);
  res.json(GetProductResponse.parse(toProductDetail(product, canSeeResellerPricing(req), related)));
});

router.get("/home-summary", async (req, res) => {
  const showReseller = canSeeResellerPricing(req);
  const active = eq(productsTable.status, "active");
  const [featured, bestSellers, newArrivals, families, [total], content] = await Promise.all([
    db.select().from(productsTable).where(and(active, eq(productsTable.isFeatured, true))).limit(8),
    db.select().from(productsTable).where(and(active, eq(productsTable.isBestSeller, true), eq(productsTable.size, "50ml"))).limit(8),
    // One card per scent (50ml), as for best sellers — not the same scent twice.
    db.select().from(productsTable).where(and(active, eq(productsTable.isNew, true), eq(productsTable.size, "50ml"))).orderBy(asc(productsTable.name)).limit(8),
    db
      .select({ name: productsTable.family, count: sql<number>`count(*)::int` })
      .from(productsTable)
      .where(active)
      .groupBy(productsTable.family),
    db.select({ count: sql<number>`count(distinct ${productsTable.name})::int` }).from(productsTable).where(active),
    siteContent(),
  ]);
  const familyCounts = new Map(families.map((f) => [f.name, f.count]));
  res.json(
    GetHomeSummaryResponse.parse({
      featured: featured.map((p) => toPublicProduct(p, showReseller)),
      bestSellers: bestSellers.map((p) => toPublicProduct(p, showReseller)),
      newArrivals: newArrivals.map((p) => toPublicProduct(p, showReseller)),
      families: FAMILIES.map((name) => ({ name, count: familyCounts.get(name) ?? 0 })),
      totalProducts: total?.count ?? 0,
      testimonials: TESTIMONIALS,
      content,
    }),
  );
});

router.post("/newsletter", async (req, res) => {
  const input = SubscribeNewsletterBody.parse(req.body);
  const contact = input.channel === "email" ? input.contact.trim().toLowerCase() : input.contact.replace(/[^\d+]/g, "");
  await db.insert(newsletterSubscribersTable).values({ channel: input.channel, contact }).onConflictDoNothing();
  res.json({ ok: true });
});

router.post("/enquiries", async (req, res) => {
  const input = SubmitEnquiryBody.parse(req.body);
  const [row] = await db
    .insert(enquiriesTable)
    .values({
      kind: input.kind,
      companyName: input.companyName ?? null,
      contactPerson: input.contactPerson,
      email: input.email.toLowerCase(),
      phone: input.phone ?? null,
      quantity: input.quantity ?? null,
      productPreference: input.productPreference ?? null,
      requiredDate: input.requiredDate ?? null,
      deliveryLocation: input.deliveryLocation ?? null,
      brandingRequirements: input.brandingRequirements ?? null,
      message: input.message,
    })
    .returning();
  await notifyAdmins(
    "enquiry",
    input.kind === "corporate" ? "New corporate / bulk enquiry" : "New contact message",
    `${input.contactPerson}${input.companyName ? ` (${input.companyName})` : ""}${input.quantity ? ` · ${input.quantity} units` : ""}: ${input.message.slice(0, 200)}`,
    "/admin?tab=enquiries",
  );
  await audit("enquiry_received", "enquiry", row!.id, req.currentUser, { kind: input.kind });
  res.status(201).json({ ok: true });
});

router.get("/referrals", async (req, res) => {
  const { code, source } = GetReferralQueryParams.parse(req.query);
  const normalised = code.trim().toUpperCase();
  const [match] = await db
    .select({ id: resellersTable.id, standing: resellersTable.standing, firstName: usersTable.firstName, userId: resellersTable.userId })
    .from(resellersTable)
    .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId))
    .where(eq(resellersTable.referralCode, normalised));
  const valid = Boolean(match && match.standing !== "suspended");
  if (match && valid && match.userId !== req.currentUser?.id) {
    const visitor = createHash("sha256")
      .update(`${req.ip ?? ""}|${req.headers["user-agent"] ?? ""}|${new Date().toISOString().slice(0, 10)}`)
      .digest("hex")
      .slice(0, 24);
    await db.insert(referralVisitsTable).values({ resellerId: match.id, source: source === "qr" ? "qr" : source === "landing" ? "landing" : "link", visitorHash: visitor });
  }
  res.json(GetReferralResponse.parse({ code: normalised, valid, resellerName: valid ? match!.firstName || null : null }));
});

export default router;
