import { createInsertSchema } from "drizzle-zod";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

const money = (name: string) =>
  numeric(name, { precision: 12, scale: 2, mode: "number" });
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * Every person who signs in. `role` drives access: customers shop at retail,
 * resellers additionally see wholesale pricing and the portal, admins manage
 * everything. Account status is the fraud/abuse lever (review/hold/suspended).
 */
export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").unique(),
    email: text("email").notNull().unique(),
    firstName: text("first_name").notNull().default(""),
    surname: text("surname").notNull().default(""),
    mobile: text("mobile"),
    role: text("role").notNull().default("customer"),
    accountStatus: text("account_status").notNull().default("active"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    suburb: text("suburb"),
    city: text("city"),
    province: text("province"),
    postalCode: text("postal_code"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [index("users_mobile_idx").on(t.mobile)],
);
export type User = typeof usersTable.$inferSelect;

export const resellerApplicationsTable = pgTable("reseller_applications", {
  id: serial("id").primaryKey(),
  applicationId: text("application_id").notNull().unique(),
  userId: integer("user_id").references(() => usersTable.id),
  firstName: text("first_name").notNull(),
  surname: text("surname").notNull(),
  mobile: text("mobile").notNull(),
  email: text("email").notNull(),
  province: text("province").notNull(),
  city: text("city").notNull(),
  contactMethod: text("contact_method").notNull(),
  heardAbout: text("heard_about").notNull(),
  referringCode: text("referring_code"),
  termsAccepted: boolean("terms_accepted").notNull(),
  privacyAccepted: boolean("privacy_accepted").notNull(),
  resellerTermsAccepted: boolean("reseller_terms_accepted")
    .notNull()
    .default(false),
  /** pending | approved | rejected | info_requested */
  status: text("status").notNull().default("pending"),
  adminNote: text("admin_note"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const insertResellerApplicationSchema = createInsertSchema(
  resellerApplicationsTable,
).omit({ id: true, createdAt: true });
export type InsertResellerApplication = z.infer<
  typeof insertResellerApplicationSchema
>;
export type ResellerApplication = typeof resellerApplicationsTable.$inferSelect;

/**
 * Approved resellers. `sponsorId` records the upline at the time of joining;
 * the team hierarchy (Manager → Team Leader → Reseller) is derived from it.
 */
export const resellersTable = pgTable(
  "resellers",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .unique()
      .references(() => usersTable.id),
    applicationId: integer("application_id").references(
      () => resellerApplicationsTable.id,
    ),
    resellerCode: text("reseller_code").notNull().unique(),
    referralCode: text("referral_code").notNull().unique(),
    sponsorId: integer("sponsor_id").references(
      (): AnyPgColumn => resellersTable.id,
    ),
    /** reseller | team_leader | manager | director */
    rank: text("rank").notNull().default("reseller"),
    /** When set, the monthly qualification run will not change the rank. */
    rankLocked: boolean("rank_locked").notNull().default(false),
    /** Consecutive months a leader failed to maintain their rank. */
    rankWarningMonths: integer("rank_warning_months").notNull().default(0),
    /** active | inactive — derived from monthly bottle sales. */
    status: text("status").notNull().default("inactive"),
    /** good | review | hold | suspended */
    standing: text("standing").notNull().default("good"),
    openingOrderCompleted: boolean("opening_order_completed")
      .notNull()
      .default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("resellers_sponsor_idx").on(t.sponsorId)],
);
export type Reseller = typeof resellersTable.$inferSelect;

export const productsTable = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    sku: text("sku").notNull().unique(),
    name: text("name").notNull(),
    /** Women's | Men's | Unisex */
    category: text("category").notNull(),
    /** Floral | Fresh | Fruity | Woody | Oriental | Sweet | Citrus */
    family: text("family").notNull(),
    description: text("description").notNull().default(""),
    scentProfile: text("scent_profile").notNull().default(""),
    topNotes: text("top_notes").array().notNull().default(sql`'{}'::text[]`),
    middleNotes: text("middle_notes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    baseNotes: text("base_notes").array().notNull().default(sql`'{}'::text[]`),
    keywords: text("keywords").notNull().default(""),
    image: text("image").notNull().default(""),
    imageAlt: text("image_alt").notNull().default(""),
    /** 50ml | 100ml */
    size: text("size").notNull(),
    retailPrice: money("retail_price").notNull(),
    recommendedRetailPrice: money("recommended_retail_price").notNull(),
    /** Never exposed publicly. */
    resellerPrice: money("reseller_price").notNull(),
    /** Never exposed publicly. */
    cost: money("cost").notNull(),
    stockQuantity: integer("stock_quantity").notNull().default(0),
    reservedQuantity: integer("reserved_quantity").notNull().default(0),
    lowStockThreshold: integer("low_stock_threshold").notNull().default(10),
    isBestSeller: boolean("is_best_seller").notNull().default(false),
    isNew: boolean("is_new").notNull().default(false),
    isFeatured: boolean("is_featured").notNull().default(false),
    /** active | inactive */
    status: text("status").notNull().default("active"),
    shopifyVariantId: text("shopify_variant_id"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("products_category_idx").on(t.category),
    index("products_family_idx").on(t.family),
  ],
);
export type Product = typeof productsTable.$inferSelect;

export const ordersTable = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    orderNumber: text("order_number").notNull().unique(),
    /** retail = customer purchase at retail; reseller = wholesale stock order */
    channel: text("channel").notNull(),
    userId: integer("user_id").references(() => usersTable.id),
    /** The buying reseller for wholesale orders. */
    resellerId: integer("reseller_id").references(() => resellersTable.id),
    /** The reseller credited with a retail customer sale. */
    attributedResellerId: integer("attributed_reseller_id").references(
      () => resellersTable.id,
    ),
    /** link | code | qr | landing | manual */
    attributionSource: text("attribution_source"),
    referralCode: text("referral_code"),
    customerFirstName: text("customer_first_name").notNull(),
    customerSurname: text("customer_surname").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerMobile: text("customer_mobile").notNull(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    suburb: text("suburb"),
    city: text("city").notNull(),
    province: text("province").notNull(),
    postalCode: text("postal_code").notNull(),
    bottles: integer("bottles").notNull(),
    subtotal: money("subtotal").notNull(),
    shippingFee: money("shipping_fee").notNull(),
    total: money("total").notNull(),
    wholesaleValue: money("wholesale_value").notNull(),
    costValue: money("cost_value").notNull(),
    /**
     * awaiting_payment | paid | processing | shipped | delivered |
     * cancelled | refunded | partially_refunded
     */
    status: text("status").notNull().default("awaiting_payment"),
    /** eft | shopify | manual */
    paymentMethod: text("payment_method").notNull(),
    paymentReference: text("payment_reference"),
    /** Calendar month (YYYY-MM, SAST) the sale counts towards. */
    period: text("period"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    courier: text("courier"),
    trackingNumber: text("tracking_number"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    shopifyOrderId: text("shopify_order_id").unique(),
    checkoutUrl: text("checkout_url"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_period_idx").on(t.period),
    index("orders_email_idx").on(t.customerEmail),
    index("orders_reseller_idx").on(t.resellerId),
    index("orders_attributed_idx").on(t.attributedResellerId),
  ],
);
export type Order = typeof ordersTable.$inferSelect;

export const orderItemsTable = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => ordersTable.id),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    size: text("size").notNull(),
    quantity: integer("quantity").notNull(),
    refundedQuantity: integer("refunded_quantity").notNull().default(0),
    /** Price the buyer paid per unit. */
    unitPrice: money("unit_price").notNull(),
    /** Wholesale (reseller) value per unit — the qualifying sales basis. */
    unitWholesale: money("unit_wholesale").notNull(),
    unitCost: money("unit_cost").notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);
export type OrderItem = typeof orderItemsTable.$inferSelect;

/**
 * Monthly qualification snapshot per reseller — the audit trail for how a
 * rank and active status were decided.
 */
export const qualificationPeriodsTable = pgTable(
  "qualification_periods",
  {
    id: serial("id").primaryKey(),
    resellerId: integer("reseller_id")
      .notNull()
      .references(() => resellersTable.id),
    period: text("period").notNull(),
    personalBottles: integer("personal_bottles").notNull(),
    personalSales: money("personal_sales").notNull(),
    teamBottles: integer("team_bottles").notNull(),
    teamSales: money("team_sales").notNull(),
    orgBottles: integer("org_bottles").notNull(),
    orgSales: money("org_sales").notNull(),
    activeDirects: integer("active_directs").notNull(),
    inactiveDirects: integer("inactive_directs").notNull(),
    activeTeamLeaders: integer("active_team_leaders").notNull(),
    activeManagers: integer("active_managers").notNull(),
    orgActiveResellers: integer("org_active_resellers").notNull(),
    isActive: boolean("is_active").notNull(),
    qualifiedRank: text("qualified_rank").notNull(),
    rankBefore: text("rank_before").notNull(),
    rankAfter: text("rank_after").notNull(),
    warning: boolean("warning").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("qp_reseller_period_uq").on(t.resellerId, t.period)],
);
export type QualificationPeriod = typeof qualificationPeriodsTable.$inferSelect;

export const periodRunsTable = pgTable("period_runs", {
  period: text("period").primaryKey(),
  /** open | closed */
  status: text("status").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  runBy: integer("run_by").references(() => usersTable.id),
  resellerCount: integer("reseller_count").notNull().default(0),
});

export const payoutsTable = pgTable("payouts", {
  id: serial("id").primaryKey(),
  payoutNumber: text("payout_number").notNull().unique(),
  resellerId: integer("reseller_id")
    .notNull()
    .references(() => resellersTable.id),
  amount: money("amount").notNull(),
  entryCount: integer("entry_count").notNull(),
  reference: text("reference"),
  /** paid */
  status: text("status").notNull().default("paid"),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: createdAt(),
});

/**
 * Commission / incentive ledger. One accrual row per order line, beneficiary
 * and incentive kind (enforced by a partial unique index over non-void rows —
 * protection against duplicate claims). Refunds never delete rows: they either mark an unpaid
 * accrual as reversed or add a negative reversal row.
 */
export const commissionLedgerTable = pgTable(
  "commission_ledger",
  {
    id: serial("id").primaryKey(),
    /** accrual | reversal */
    entryType: text("entry_type").notNull().default("accrual"),
    orderId: integer("order_id")
      .notNull()
      .references(() => ordersTable.id),
    orderItemId: integer("order_item_id")
      .notNull()
      .references(() => orderItemsTable.id),
    orderNumber: text("order_number").notNull(),
    period: text("period").notNull(),
    productName: text("product_name").notNull(),
    quantity: integer("quantity").notNull(),
    /** The reseller whose product sale generated the incentive. */
    sellerResellerId: integer("seller_reseller_id")
      .notNull()
      .references(() => resellersTable.id),
    beneficiaryResellerId: integer("beneficiary_reseller_id")
      .notNull()
      .references(() => resellersTable.id),
    /** team_leader | manager | director | referral */
    kind: text("kind").notNull(),
    beneficiaryRank: text("beneficiary_rank").notNull(),
    rate: numeric("rate", { precision: 6, scale: 3, mode: "number" }).notNull(),
    baseValue: money("base_value").notNull(),
    amount: money("amount").notNull(),
    /** provisional | qualified | not_qualified */
    qualificationStatus: text("qualification_status")
      .notNull()
      .default("provisional"),
    /** pending | approved | paid | reversed | void */
    status: text("status").notNull().default("pending"),
    reversalOfId: integer("reversal_of_id").references(
      (): AnyPgColumn => commissionLedgerTable.id,
    ),
    payoutId: integer("payout_id").references(() => payoutsTable.id),
    note: text("note"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ledger_accrual_uq")
      .on(t.orderItemId, t.beneficiaryResellerId, t.kind)
      .where(sql`entry_type = 'accrual' and status <> 'void'`),
    index("ledger_beneficiary_idx").on(t.beneficiaryResellerId),
    index("ledger_period_idx").on(t.period),
  ],
);
export type LedgerEntry = typeof commissionLedgerTable.$inferSelect;

/**
 * Single-row table (id = 1) of every business rule the administrator can
 * change. Nothing here may be hard-coded elsewhere.
 */
export const compensationSettingsTable = pgTable("compensation_settings", {
  id: integer("id").primaryKey().default(1),
  openingOrder: integer("opening_order").notNull().default(10),
  reorderMinimum: integer("reorder_minimum").notNull().default(1),
  teamLeaderRate: numeric("team_leader_rate", {
    precision: 5,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(5),
  managerRate: numeric("manager_rate", {
    precision: 5,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(2),
  directorRate: numeric("director_rate", {
    precision: 5,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(1),
  directorEnabled: boolean("director_enabled").notNull().default(false),
  referralRate: numeric("referral_rate", {
    precision: 5,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  countAttributedRetail: boolean("count_attributed_retail")
    .notNull()
    .default(true),
  /** Team Leader: personal bottles / month. */
  personalTarget: integer("personal_target").notNull().default(20),
  /** Team Leader: qualifying team bottles / month. */
  teamTarget: integer("team_target").notNull().default(100),
  tlActiveDirects: integer("tl_active_directs").notNull().default(5),
  mgrActiveTeamLeaders: integer("mgr_active_team_leaders")
    .notNull()
    .default(3),
  mgrActiveResellers: integer("mgr_active_resellers").notNull().default(15),
  mgrOrgBottles: integer("mgr_org_bottles").notNull().default(300),
  mgrPersonalBottles: integer("mgr_personal_bottles").notNull().default(20),
  dirActiveManagers: integer("dir_active_managers").notNull().default(5),
  dirActiveResellers: integer("dir_active_resellers").notNull().default(50),
  dirOrgBottles: integer("dir_org_bottles").notNull().default(1000),
  /** Bottles a reseller must sell in a month to count as active. */
  activeMinBottles: integer("active_min_bottles").notNull().default(1),
  /** Bottles an inactive reseller must sell in a month to reactivate. */
  reactivationBottles: integer("reactivation_bottles").notNull().default(10),
  /** Warning months before a leader who fails qualification is reverted. */
  rankGraceMonths: integer("rank_grace_months").notNull().default(1),
  largeOrderBottles: integer("large_order_bottles").notNull().default(50),
  shippingFlatRate: money("shipping_flat_rate").notNull().default(99),
  freeShippingThreshold: money("free_shipping_threshold")
    .notNull()
    .default(750),
  monthlyContributionTarget: money("monthly_contribution_target")
    .notNull()
    .default(150000),
  updatedAt: updatedAt(),
});
export type CompensationSettings = typeof compensationSettingsTable.$inferSelect;

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    action: text("action").notNull(),
    actorId: text("actor_id"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: text("metadata"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;

export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    /** null userId + audience admin = visible to every administrator */
    userId: integer("user_id").references(() => usersTable.id),
    audience: text("audience").notNull().default("user"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId)],
);

export const marketingMaterialsTable = pgTable("marketing_materials", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  /** product_images | descriptions | social | whatsapp | price_list | catalogue | campaign | video | training */
  category: text("category").notNull(),
  url: text("url").notNull(),
  description: text("description").notNull().default(""),
  /** Lowest rank that can see it: reseller | team_leader | manager */
  minRank: text("min_rank").notNull().default("reseller"),
  createdAt: createdAt(),
});

export const enquiriesTable = pgTable("enquiries", {
  id: serial("id").primaryKey(),
  /** corporate | contact */
  kind: text("kind").notNull(),
  companyName: text("company_name"),
  contactPerson: text("contact_person").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  quantity: integer("quantity"),
  productPreference: text("product_preference"),
  requiredDate: text("required_date"),
  deliveryLocation: text("delivery_location"),
  brandingRequirements: text("branding_requirements"),
  message: text("message").notNull().default(""),
  /** new | in_progress | closed */
  status: text("status").notNull().default("new"),
  createdAt: createdAt(),
});

export const fraudFlagsTable = pgTable("fraud_flags", {
  id: serial("id").primaryKey(),
  /** self_referral | duplicate_order | duplicate_account | unusual_order | large_order | refund_commission | suspicious_referral */
  type: text("type").notNull(),
  /** low | medium | high */
  severity: text("severity").notNull(),
  resellerId: integer("reseller_id").references(() => resellersTable.id),
  orderId: integer("order_id").references(() => ordersTable.id),
  userId: integer("user_id").references(() => usersTable.id),
  detail: text("detail").notNull(),
  /** open | resolved | dismissed */
  status: text("status").notNull().default("open"),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const wishlistItemsTable = pgTable(
  "wishlist_items",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

export const newsletterSubscribersTable = pgTable("newsletter_subscribers", {
  id: serial("id").primaryKey(),
  /** email | whatsapp */
  channel: text("channel").notNull(),
  contact: text("contact").notNull().unique(),
  createdAt: createdAt(),
});

export const referralVisitsTable = pgTable(
  "referral_visits",
  {
    id: serial("id").primaryKey(),
    resellerId: integer("reseller_id")
      .notNull()
      .references(() => resellersTable.id),
    source: text("source").notNull().default("link"),
    visitorHash: text("visitor_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("referral_visits_reseller_idx").on(t.resellerId)],
);

/** Editable website copy (hero, announcement bar, banking details, …). */
export const siteContentTable = pgTable("site_content", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});
