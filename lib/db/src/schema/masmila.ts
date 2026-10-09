import { createInsertSchema } from "drizzle-zod";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgSequence,
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

/**
 * Source of order numbers (MM-YYMMDD-00042): unique by construction, so
 * concurrent checkouts can never collide and nothing has to be retried.
 */
export const orderNumberSequence = pgSequence("order_number_seq", { startWith: 1 });

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
    /** Client-generated idempotency key: a retried checkout returns this order instead of creating another. */
    checkoutKey: text("checkout_key"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_period_idx").on(t.period),
    index("orders_email_idx").on(t.customerEmail),
    index("orders_reseller_idx").on(t.resellerId),
    index("orders_attributed_idx").on(t.attributedResellerId),
    uniqueIndex("orders_checkout_key_uq").on(t.checkoutKey).where(sql`checkout_key is not null`),
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
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    check("order_items_refunded_quantity_range", sql`${t.refundedQuantity} >= 0 and ${t.refundedQuantity} <= ${t.quantity}`),
  ],
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

/**
 * One row per month's qualification run, which doubles as its lease: a runner
 * owns the month while `status = 'running'` and `lease_expires_at` is in the
 * future, renewing the lease as it works. An expired lease (crashed or timed
 * out runner) or a failed run can be claimed again; see lib/jobs.ts.
 */
export const periodRunsTable = pgTable("period_runs", {
  period: text("period").primaryKey(),
  /** running | closed | failed (legacy rows may say open) */
  status: text("status").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  runBy: integer("run_by").references(() => usersTable.id),
  resellerCount: integer("reseller_count").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  /** Attempts since the month last closed successfully. */
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** History of scheduled/admin job executions: every attempt, its outcome and error. */
export const jobRunsTable = pgTable(
  "job_runs",
  {
    id: serial("id").primaryKey(),
    /** month_end_qualification | eft_reservation_expiry */
    job: text("job").notNull(),
    period: text("period"),
    /** schedule | admin | startup | cli | test */
    trigger: text("trigger").notNull(),
    actorId: integer("actor_id").references(() => usersTable.id),
    owner: text("owner").notNull(),
    attempt: integer("attempt").notNull().default(1),
    /** running | succeeded | failed | abandoned (lease lost: crashed, timed out or superseded) */
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    /** JSON summary of what the run did. */
    result: text("result"),
  },
  (t) => [
    index("job_runs_job_started_idx").on(t.job, t.startedAt),
    check("job_runs_status_valid", sql`${t.status} in ('running', 'succeeded', 'failed', 'abandoned')`),
  ],
);
export type JobRun = typeof jobRunsTable.$inferSelect;

/**
 * A payout is calculated (allocating approved ledger rows to it) separately
 * from being executed. Lifecycle: pending (calculated) → approved →
 * processing (handed to the bank / EFT batch) → paid, or failed (its ledger
 * rows are released for a later payout). Nothing here moves money: the
 * administrator records each step. At most one non-failed payout per
 * reseller and payout period. Legacy rows (before this lifecycle) are
 * `paid` with no period.
 */
export const payoutsTable = pgTable(
  "payouts",
  {
    id: serial("id").primaryKey(),
    payoutNumber: text("payout_number").notNull().unique(),
    resellerId: integer("reseller_id")
      .notNull()
      .references(() => resellersTable.id),
    /** Payout run period (YYYY-MM): approved incentives of this and earlier periods. */
    period: text("period"),
    amount: money("amount").notNull(),
    entryCount: integer("entry_count").notNull(),
    reference: text("reference"),
    /** pending | approved | processing | paid | failed */
    status: text("status").notNull().default("pending"),
    createdBy: integer("created_by").references(() => usersTable.id),
    createdAt: createdAt(),
    approvedBy: integer("approved_by").references(() => usersTable.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    processingBy: integer("processing_by").references(() => usersTable.id),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    paidBy: integer("paid_by").references(() => usersTable.id),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    failedBy: integer("failed_by").references(() => usersTable.id),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payouts_reseller_period_uq")
      .on(t.resellerId, t.period)
      .where(sql`period is not null and status <> 'failed'`),
    check("payouts_amount_positive", sql`${t.amount} > 0`),
    check("payouts_status_valid", sql`${t.status} in ('pending', 'approved', 'processing', 'paid', 'failed')`),
  ],
);
export type Payout = typeof payoutsTable.$inferSelect;

/**
 * Every refund, cancellation, return or chargeback, once. `externalId` is the
 * stable id of the source event (Shopify refund id, admin idempotency key):
 * a replayed event finds the existing row instead of applying twice.
 */
export const refundsTable = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => ordersTable.id),
    /** refund | cancel | return | chargeback */
    type: text("type").notNull(),
    /** admin | shopify */
    source: text("source").notNull(),
    externalId: text("external_id"),
    reason: text("reason").notNull(),
    /** Value of the refunded units at the price the buyer paid (0 for an unpaid cancellation). */
    amount: money("amount").notNull(),
    /** False for cancelling an unpaid order: reservations released, no money or incentives involved. */
    orderWasPaid: boolean("order_was_paid").notNull(),
    initiatedBy: integer("initiated_by").references(() => usersTable.id),
    /** "user:<id>" or the integration that sent the event (e.g. "shopify"). */
    actor: text("actor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refunds_source_external_uq").on(t.source, t.externalId).where(sql`external_id is not null`),
    index("refunds_order_idx").on(t.orderId),
  ],
);
export type Refund = typeof refundsTable.$inferSelect;

export const refundItemsTable = pgTable(
  "refund_items",
  {
    id: serial("id").primaryKey(),
    refundId: integer("refund_id")
      .notNull()
      .references(() => refundsTable.id),
    orderItemId: integer("order_item_id")
      .notNull()
      .references(() => orderItemsTable.id),
    quantity: integer("quantity").notNull(),
    amount: money("amount").notNull(),
    /** Units returned to stock (cancel/return), or released from reservation (unpaid cancel). */
    restockedQuantity: integer("restocked_quantity").notNull().default(0),
  },
  (t) => [
    uniqueIndex("refund_items_refund_item_uq").on(t.refundId, t.orderItemId),
    index("refund_items_order_item_idx").on(t.orderItemId),
    check("refund_items_quantity_positive", sql`${t.quantity} > 0`),
  ],
);
export type RefundItem = typeof refundItemsTable.$inferSelect;

/**
 * Commission / incentive ledger. One accrual row per order line, beneficiary
 * and incentive kind (enforced by a partial unique index over non-void rows —
 * protection against duplicate claims). An accrual's amount is fixed at the
 * line's full quantity; each refund adds one negative reversal row per
 * affected accrual (unique per refund + accrual), so the net incentive is
 * accrual + reversals and rows are never deleted or resized. Legacy rows may
 * carry the old `reversed` status.
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
    /** The refund a reversal row belongs to (null for accruals and legacy reversals). */
    refundId: integer("refund_id").references(() => refundsTable.id),
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
    // A refund reverses each accrual at most once.
    uniqueIndex("ledger_refund_reversal_uq")
      .on(t.refundId, t.reversalOfId)
      .where(sql`refund_id is not null`),
    index("ledger_beneficiary_idx").on(t.beneficiaryResellerId),
    index("ledger_period_idx").on(t.period),
    index("ledger_order_idx").on(t.orderId),
    index("ledger_reversal_of_idx").on(t.reversalOfId),
    index("ledger_payout_idx").on(t.payoutId),
    check(
      "ledger_amount_sign",
      sql`(${t.entryType} = 'accrual' and ${t.amount} >= 0) or (${t.entryType} = 'reversal' and ${t.amount} <= 0)`,
    ),
    check("ledger_status_valid", sql`${t.status} in ('pending', 'approved', 'paid', 'reversed', 'void')`),
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
  /**
   * Bulk pricing for reseller stock orders: "minBottles:percentOff" pairs,
   * e.g. "50:5,100:10" = 5% off reseller price from 50 bottles, 10% from 100.
   * Empty = no bulk discounts.
   */
  bulkDiscountTiers: text("bulk_discount_tiers").notNull().default(""),
  /**
   * Hours an unpaid EFT order keeps its stock reserved before it is cancelled
   * automatically. Null = never expire (requires a business decision; see
   * docs/OPERATIONS.md).
   */
  eftReservationHours: integer("eft_reservation_hours"),
  /**
   * Hours an unpaid Shopify checkout (abandoned cart) keeps its stock reserved.
   * Null = never expire (requires a business decision; see docs/OPERATIONS.md).
   */
  shopifyReservationHours: integer("shopify_reservation_hours"),
  updatedAt: updatedAt(),
}, (t) => [
  check("settings_eft_reservation_hours_positive", sql`${t.eftReservationHours} is null or ${t.eftReservationHours} > 0`),
  check("settings_shopify_reservation_hours_positive", sql`${t.shopifyReservationHours} is null or ${t.shopifyReservationHours} > 0`),
]);
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

/**
 * Files uploaded by administrators (marketing images, price lists, PDFs),
 * served at /api/files/:id. Kept in Postgres so uploads work on any host,
 * including serverless; large videos should be linked instead.
 */
export const uploadedFilesTable = pgTable("uploaded_files", {
  id: serial("id").primaryKey(),
  /** Unguessable part of the file URL (files can include reseller price lists). */
  token: text("token").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  /** base64-encoded content */
  data: text("data").notNull(),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id),
  createdAt: createdAt(),
});

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
  /** The quarantined payment this flag is about; resolving that payment closes the flag. */
  paymentEventId: integer("payment_event_id").references((): AnyPgColumn => paymentEventsTable.id),
  id: serial("id").primaryKey(),
  /** self_referral | duplicate_order | payment_rejected | webhook_rejected | duplicate_account | unusual_order | large_order | refund_commission | suspicious_referral */
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

/**
 * Every payment notification received from a provider, whatever the outcome.
 * `event_key` identifies the payment (e.g. "orders/paid:<Shopify order id>"),
 * so retried or concurrent deliveries of the same payment are recorded — and
 * applied — once. Rejected payments stay here (quarantined) for review; they
 * never change an order, stock or incentives.
 */
export const paymentEventsTable = pgTable(
  "payment_events",
  {
    id: serial("id").primaryKey(),
    /** shopify */
    provider: text("provider").notNull(),
    topic: text("topic").notNull(),
    eventKey: text("event_key").notNull(),
    /** Provider delivery id (X-Shopify-Webhook-Id), for tracing. */
    deliveryId: text("delivery_id"),
    /**
     * Provenance of the delivery, for proving a payment came from the real
     * provider: the sending store (X-Shopify-Shop-Domain, checked against the
     * configured store), the webhook API version, and Shopify's test flag.
     */
    shopDomain: text("shop_domain"),
    apiVersion: text("api_version"),
    testPayment: boolean("test_payment"),
    orderId: integer("order_id").references(() => ordersTable.id),
    externalOrderId: text("external_order_id"),
    externalReference: text("external_reference"),
    amount: money("amount"),
    currency: text("currency"),
    financialStatus: text("financial_status"),
    /** applied | already_applied | rejected */
    outcome: text("outcome").notNull(),
    /** Why a payment was rejected (amount_mismatch, currency_mismatch, partial_payment, …). */
    reason: text("reason"),
    createdAt: createdAt(),
    /**
     * Administrator resolution of a rejected (quarantined) payment. Recording
     * a resolution never changes the order or moves money; it documents what
     * was done elsewhere (refund in Shopify, manual confirmation, …).
     */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: integer("resolved_by").references(() => usersTable.id),
    /** refunded_in_shopify | confirmed_order_paid | no_action_required | other */
    resolutionAction: text("resolution_action"),
    resolutionReason: text("resolution_reason"),
    /** Order status when the resolution was recorded. */
    resolutionOrderStatus: text("resolution_order_status"),
  },
  (t) => [
    uniqueIndex("payment_events_provider_key_uq").on(t.provider, t.eventKey),
    index("payment_events_order_idx").on(t.orderId),
    check("payment_events_outcome_valid", sql`${t.outcome} in ('applied', 'already_applied', 'rejected')`),
    check(
      "payment_events_resolution_valid",
      sql`(${t.resolvedAt} is null and ${t.resolvedBy} is null and ${t.resolutionAction} is null and ${t.resolutionReason} is null)
        or (${t.outcome} = 'rejected' and ${t.resolvedAt} is not null and ${t.resolvedBy} is not null
            and ${t.resolutionAction} in ('refunded_in_shopify', 'confirmed_order_paid', 'no_action_required', 'other')
            and length(trim(${t.resolutionReason})) >= 5)`,
    ),
  ],
);
export type PaymentEvent = typeof paymentEventsTable.$inferSelect;

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

/**
 * Migrations applied by lib/db/scripts/migrate.mjs (one row per file in
 * lib/db/migrations). Declared here so `drizzle-kit push` on a development
 * database keeps the table instead of dropping it.
 */
export const schemaMigrationsTable = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Shared rate-limit counters (fixed window), so every server instance and
 * serverless function counts against the same allowance. `bucket` is a hash
 * of the client address and endpoint — no raw IP addresses are stored.
 */
export const rateLimitsTable = pgTable("rate_limits", {
  bucket: text("bucket").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

/**
 * Which environment this database belongs to (production | staging |
 * development), set once with the migration runner (`--environment`). A
 * deployment refuses to serve from a database marked for another environment,
 * so a deploy preview can never write to the production database.
 */
export const deploymentMarkerTable = pgTable(
  "deployment_marker",
  {
    id: integer("id").primaryKey().default(1),
    environment: text("environment").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
    markedBy: text("marked_by"),
  },
  (t) => [
    check("deployment_marker_single_row", sql`${t.id} = 1`),
    check("deployment_marker_environment_valid", sql`${t.environment} in ('production', 'staging', 'development')`),
  ],
);

/** Editable website copy (hero, announcement bar, banking details, …). */
export const siteContentTable = pgTable("site_content", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: updatedAt(),
});
