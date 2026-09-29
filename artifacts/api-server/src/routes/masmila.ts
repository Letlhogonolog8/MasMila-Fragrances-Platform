import { Router, type IRouter } from "express";
import {
  GetAdminSummaryResponse,
  GetHomeSummaryResponse,
  GetResellerPortalResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  SubmitResellerApplicationBody,
  SubmitResellerApplicationResponse,
  UpdateAdminSettingsBody,
  UpdateAdminSettingsResponse,
} from "@workspace/api-zod";
import { db, auditLogsTable, compensationSettingsTable, resellerApplicationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { shopifyStorefrontRequest } from "../lib/shopifyStorefrontClient";

const router: IRouter = Router();

const productImages = [
  "https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1615634260167-c8cdede054de?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1588405748880-12d1d2a59f75?auto=format&fit=crop&w=900&q=85",
  "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=900&q=85",
];

const products = [
  {
    id: "mila-001",
    name: "Velvet Bloom",
    sku: "MM-VB-50",
    family: "Floral",
    category: "Women's",
    size: "50ml",
    price: 299,
    image: productImages[0],
    notes: ["Peony", "Rose", "Soft musk"],
    badge: "Best seller",
  },
  {
    id: "mila-002",
    name: "Solaris",
    sku: "MM-SO-100",
    family: "Citrus",
    category: "Unisex",
    size: "100ml",
    price: 399,
    image: productImages[1],
    notes: ["Bergamot", "Neroli", "Cedar"],
    badge: "New",
  },
  {
    id: "mila-003",
    name: "After Dark",
    sku: "MM-AD-50",
    family: "Oriental",
    category: "Men's",
    size: "50ml",
    price: 299,
    image: productImages[2],
    notes: ["Black pepper", "Amber", "Vanilla"],
    badge: null,
  },
  {
    id: "mila-004",
    name: "Golden Hour",
    sku: "MM-GH-100",
    family: "Woody",
    category: "Unisex",
    size: "100ml",
    price: 399,
    image: productImages[3],
    notes: ["Fig leaf", "Sandalwood", "Tonka"],
    badge: "Staff pick",
  },
  {
    id: "mila-005",
    name: "Pure Intention",
    sku: "MM-PI-50",
    family: "Fresh",
    category: "Women's",
    size: "50ml",
    price: 299,
    image: productImages[1],
    notes: ["Lemon", "White tea", "Musk"],
    badge: null,
  },
  {
    id: "mila-006",
    name: "Noir Woods",
    sku: "MM-NW-100",
    family: "Woody",
    category: "Men's",
    size: "100ml",
    price: 399,
    image: productImages[2],
    notes: ["Cardamom", "Vetiver", "Oakmoss"],
    badge: null,
  },
];

const activities = [
  {
    id: "activity-1",
    label: "Order MM-1048 attributed",
    detail: "3 bottles · R1,197 wholesale value",
    time: "Today, 09:42",
    tone: "green",
  },
  {
    id: "activity-2",
    label: "Team milestone reached",
    detail: "Your team is 18 bottles from target",
    time: "Yesterday",
    tone: "gold",
  },
  {
    id: "activity-3",
    label: "New referral joined",
    detail: "Lerato M. applied through your link",
    time: "Mon, 14:08",
    tone: "plum",
  },
];

const fallbackSettings = {
  openingOrder: 10,
  teamLeaderRate: 5,
  managerRate: 2,
  directorRate: 1,
  personalTarget: 20,
  teamTarget: 100,
};

type ShopifyProductResponse = {
  products: {
    nodes: Array<{
      id: string;
      title: string;
      handle: string;
      featuredImage?: { url: string; altText?: string | null } | null;
      priceRange: { minVariantPrice: { amount: string } };
      variants: { nodes: Array<{ id: string; title: string; availableForSale: boolean }> };
    }>;
  };
};

async function loadProducts() {
  try {
    const data = await shopifyStorefrontRequest<ShopifyProductResponse>(`#graphql
      query Products {
        products(first: 24) {
          nodes {
            id title handle
            featuredImage { url altText }
            priceRange { minVariantPrice { amount } }
            variants(first: 1) { nodes { id title availableForSale } }
          }
        }
      }
    `);
    if (data.products.nodes.length) {
      return data.products.nodes.map((product, index) => ({
        id: product.id,
        name: product.title,
        sku: product.handle.toUpperCase(),
        family: ["Floral", "Fresh", "Woody", "Citrus"][index % 4],
        category: "Unisex",
        size: product.variants.nodes[0]?.title || "50ml",
        price: Number(product.priceRange.minVariantPrice.amount),
        image: product.featuredImage?.url || productImages[index % productImages.length],
        notes: ["Signature blend", "Mas'Mila fragrance"],
        badge: product.variants.nodes[0]?.availableForSale ? null : "Coming soon",
      }));
    }
  } catch {
    // The review catalog remains available until the connected store has published products.
  }
  return products;
}

router.get("/products", async (req, res) => {
  const query = ListProductsQueryParams.parse(req.query);
  const catalog = await loadProducts();
  const search = query.search?.toLowerCase().trim();
  const filtered = catalog
    .filter((product) => !query.category || product.category === query.category || product.family === query.category)
    .filter((product) => {
      if (!search) return true;
      return [product.name, product.sku, product.family, product.category, ...product.notes]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .slice(0, query.limit ?? 12);

  res.json(ListProductsResponse.parse(filtered));
});

router.get("/home-summary", async (_req, res) => {
  const catalog = await loadProducts();
  res.json(
    GetHomeSummaryResponse.parse({
      featured: catalog.slice(0, 4),
      totalProducts: 160,
      families: ["Floral", "Fresh", "Woody", "Citrus", "Oriental", "Sweet"],
    }),
  );
});

router.post("/reseller-applications", async (req, res) => {
  const input = SubmitResellerApplicationBody.parse(req.body);
  const application = {
    id: `APP-${Date.now()}`,
    status: "pending",
    message: "Your application is in the Mas'Mila approval queue. We'll be in touch shortly.",
  };
  await db.insert(resellerApplicationsTable).values({
    applicationId: application.id,
    ...input,
    referringCode: input.referringCode || null,
    status: application.status,
  });
  await db.insert(auditLogsTable).values({
    action: "reseller_application_submitted",
    entityType: "reseller_application",
    entityId: application.id,
    metadata: JSON.stringify({ email: input.email }),
  });
  res.status(201).json(SubmitResellerApplicationResponse.parse(application));
});

router.get("/reseller-portal", (_req, res) => {
  res.json(
    GetResellerPortalResponse.parse({
      name: "Nomdade",
      rank: "Team Leader",
      status: "Active",
      resellerId: "MSM-000123",
      referralCode: "NOMDADE123",
      personalSales: 9240,
      personalBottles: 24,
      teamBottles: 82,
      progress: 82,
      nextRank: "Manager",
      teamLeaders: 2,
      activity: activities,
      incentive: 700,
    }),
  );
});

router.get("/admin-summary", (_req, res) => {
  res.json(
    GetAdminSummaryResponse.parse({
      revenue: 148620,
      bottles: 488,
      activeResellers: 86,
      pendingIncentives: 12480,
      weeklySales: [
        { label: "Mon", value: 18200 },
        { label: "Tue", value: 24500 },
        { label: "Wed", value: 19800 },
        { label: "Thu", value: 28600 },
        { label: "Fri", value: 32400 },
        { label: "Sat", value: 25120 },
      ],
      topProducts: [
        { name: "Velvet Bloom", units: 118, revenue: 35282 },
        { name: "Solaris", units: 96, revenue: 38304 },
        { name: "After Dark", units: 84, revenue: 25116 },
        { name: "Golden Hour", units: 76, revenue: 30324 },
      ],
    }),
  );
});

router.get("/admin-settings", async (_req, res) => {
  const [row] = await db.select().from(compensationSettingsTable).where(eq(compensationSettingsTable.id, 1));
  res.json(UpdateAdminSettingsResponse.parse(row ?? fallbackSettings));
});

router.patch("/admin-settings", async (req, res) => {
  const next = UpdateAdminSettingsBody.parse(req.body);
  const [row] = await db
    .insert(compensationSettingsTable)
    .values({
      id: 1,
      ...next,
      teamLeaderRate: String(next.teamLeaderRate),
      managerRate: String(next.managerRate),
      directorRate: String(next.directorRate),
    })
    .onConflictDoUpdate({
      target: compensationSettingsTable.id,
      set: {
        ...next,
        teamLeaderRate: String(next.teamLeaderRate),
        managerRate: String(next.managerRate),
        directorRate: String(next.directorRate),
        updatedAt: new Date(),
      },
    })
    .returning();
  await db.insert(auditLogsTable).values({
    action: "compensation_settings_updated",
    entityType: "compensation_settings",
    entityId: "1",
    metadata: JSON.stringify(next),
  });
  res.json(UpdateAdminSettingsResponse.parse(row));
});

export default router;