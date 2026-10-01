import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import {
  ApproveCommissionsBody,
  CreateAdminProductBody,
  CreateMarketingMaterialBody,
  CreatePayoutsBody,
  CreatePayoutsResponse,
  DecideApplicationBody,
  DecideApplicationParams,
  DecideApplicationResponse,
  DeleteMarketingMaterialParams,
  GetAdminReportQueryParams,
  GetAdminReportResponse,
  GetAdminSettingsResponse,
  GetAdminSummaryResponse,
  GetQualificationQueryParams,
  GetQualificationResponse,
  ListAdminApplicationsQueryParams,
  ListAdminApplicationsResponse,
  ListAdminCommissionsQueryParams,
  ListAdminCommissionsResponse,
  ListAdminCustomersQueryParams,
  ListAdminCustomersResponse,
  ListAdminEnquiriesResponse,
  ListAdminMarketingMaterialsResponse,
  ListAdminOrdersQueryParams,
  ListAdminOrdersResponse,
  ListAdminPayoutsResponse,
  ListAdminProductsResponse,
  ListAdminResellersQueryParams,
  ListAdminResellersResponse,
  ListAdminTeamsResponse,
  ListAuditLogsQueryParams,
  ListAuditLogsResponse,
  ListFraudFlagsResponse,
  RefundAdminOrderBody,
  RefundAdminOrderParams,
  RefundAdminOrderResponse,
  RunQualificationBody,
  RunQualificationResponse,
  UpdateAdminCustomerBody,
  UpdateAdminCustomerParams,
  UpdateAdminCustomerResponse,
  UpdateAdminEnquiryBody,
  UpdateAdminEnquiryParams,
  UpdateAdminOrderBody,
  UpdateAdminOrderParams,
  UpdateAdminOrderResponse,
  UpdateAdminProductBody,
  UpdateAdminProductParams,
  UpdateAdminResellerBody,
  UpdateAdminResellerParams,
  UpdateAdminSettingsBody,
  UpdateAdminSettingsResponse,
  UpdateFraudFlagBody,
  UpdateFraudFlagParams,
  UpdateSiteContentBody,
  UpdateSiteContentResponse,
  CreateAdminProductResponse,
  UpdateAdminProductResponse,
  CreateMarketingMaterialResponse,
  SendAnnouncementBody,
  UpdateMarketingMaterialBody,
  UpdateMarketingMaterialParams,
  UpdateMarketingMaterialResponse,
  UploadFileBody,
  UploadFileResponse,
  UpdateAdminResellerResponse,
  UpdateFraudFlagResponse,
  UpdateAdminEnquiryResponse,
} from "@workspace/api-zod";
import {
  db,
  auditLogsTable,
  commissionLedgerTable,
  enquiriesTable,
  fraudFlagsTable,
  marketingMaterialsTable,
  uploadedFilesTable,
  orderItemsTable,
  ordersTable,
  payoutsTable,
  periodRunsTable,
  productsTable,
  qualificationPeriodsTable,
  resellerApplicationsTable,
  resellersTable,
  siteContentTable,
  usersTable,
  type Product,
  type Reseller,
} from "@workspace/db";
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { requireAdmin } from "../lib/auth";
import { available } from "../lib/catalog";
import { RANK_LABELS, rankValue } from "../lib/engine";
import { badRequest, HttpError, iso, notFound, round2 } from "../lib/http";
import { evaluatePeriod, PAID_STATUSES, resellerNames, runQualification } from "../lib/network";
import { currentPeriod, periodBounds, previousPeriod, sastDateLabel, shiftPeriod, startOfDay } from "../lib/period";
import { getSettings, updateSettings } from "../lib/settings";
import { audit } from "../lib/audit";
import { notifyEmail, notifyMany, notifyUser } from "../lib/notify";
import { getOrderView, refundOrder, serializeOrders, updateFulfilment } from "../lib/orders";
import { duplicateIdentityWarnings } from "../lib/fraud";
import { isUniqueViolation, randomCode, referralCodeFor, resellerCodeFor, slugify } from "../lib/codes";
import { buildReport, toCsv, type ReportType } from "../lib/reports";
import { serializeLedger } from "./reseller";
import { siteContent } from "./catalog";

const router: IRouter = Router();
router.use("/admin", requireAdmin);

const DAY = 24 * 3600 * 1000;

// ------------------------------------------------------------------ summary

async function salesBetween(start: Date, end: Date) {
  const rows = await db.execute<{ channel: string; orders: number; revenue: string; wholesale: string; cost: string; bottles: string }>(sql`
    select o.channel, count(distinct o.id)::int as orders,
      coalesce(sum((i.quantity - i.refunded_quantity) * i.unit_price), 0)::text as revenue,
      coalesce(sum((i.quantity - i.refunded_quantity) * i.unit_wholesale), 0)::text as wholesale,
      coalesce(sum((i.quantity - i.refunded_quantity) * i.unit_cost), 0)::text as cost,
      coalesce(sum(i.quantity - i.refunded_quantity), 0)::text as bottles
    from orders o join order_items i on i.order_id = o.id
    where o.paid_at >= ${start} and o.paid_at < ${end} and o.status in ${PAID_STATUSES}
    group by o.channel
  `);
  const pick = (channel?: string) => rows.rows.filter((r) => !channel || r.channel === channel);
  const sum = (list: typeof rows.rows, key: "revenue" | "wholesale" | "cost" | "bottles" | "orders") => list.reduce((s, r) => s + Number(r[key]), 0);
  return {
    revenue: round2(sum(pick(), "revenue")),
    retail: round2(sum(pick("retail"), "revenue")),
    reseller: round2(sum(pick("reseller"), "revenue")),
    wholesale: round2(sum(pick(), "wholesale")),
    cost: round2(sum(pick(), "cost")),
    bottles: sum(pick(), "bottles"),
    orders: sum(pick(), "orders"),
  };
}

router.get("/admin/summary", async (_req, res) => {
  const now = new Date();
  const period = currentPeriod();
  const { start: monthStart, end: monthEnd } = periodBounds(period);
  const today = startOfDay(now);
  const yearStart = periodBounds(`${period.slice(0, 4)}-01`).start;
  const settings = await getSettings();

  const lastSix = Array.from({ length: 6 }, (_, i) => shiftPeriod(period, i - 5));
  const [day, week, month, year, snapshot, monthly] = await Promise.all([
    salesBetween(today, new Date(today.getTime() + DAY)),
    salesBetween(new Date(today.getTime() - 6 * DAY), new Date(today.getTime() + DAY)),
    salesBetween(monthStart, monthEnd),
    salesBetween(yearStart, monthEnd),
    evaluatePeriod(period, settings),
    Promise.all(lastSix.map((p) => {
      const b = periodBounds(p);
      return salesBetween(b.start, b.end).then((s) => ({ label: p, value: s.revenue }));
    })),
  ]);

  const perf = await db.execute<{ id: number; name: string; sku: string; size: string; units: string; revenue: string; cost: string }>(sql`
    select p.id, p.name, p.sku, p.size,
      coalesce(sum(i.quantity - i.refunded_quantity) filter (where o.id is not null), 0)::text as units,
      coalesce(sum((i.quantity - i.refunded_quantity) * i.unit_price) filter (where o.id is not null), 0)::text as revenue,
      coalesce(sum((i.quantity - i.refunded_quantity) * i.unit_cost) filter (where o.id is not null), 0)::text as cost
    from products p
    left join order_items i on i.product_id = p.id
    left join orders o on o.id = i.order_id and o.paid_at >= ${monthStart} and o.paid_at < ${monthEnd} and o.status in ${PAID_STATUSES}
    where p.status = 'active'
    group by p.id order by p.name
  `);
  const performance = perf.rows.map((p) => ({
    name: `${p.name} ${p.size}`,
    sku: p.sku,
    units: Number(p.units),
    revenue: round2(Number(p.revenue)),
    cost: round2(Number(p.cost)),
    grossProfit: round2(Number(p.revenue) - Number(p.cost)),
  }));
  const products = await db.select().from(productsTable);
  const lowStock = products
    .filter((p) => p.status === "active" && available(p) <= p.lowStockThreshold)
    .sort((a, b) => available(a) - available(b))
    .map((p) => ({ id: p.id, name: `${p.name} ${p.size}`, sku: p.sku, available: available(p), threshold: p.lowStockThreshold }));

  const resellers = [...snapshot.resellers.values()];
  const names = await resellerNames(resellers.map((r) => r.id));
  const seller = (r: Reseller, bottles: number, sales: number) => ({
    name: names.get(r.id)?.name ?? r.resellerCode,
    resellerCode: r.resellerCode,
    rank: RANK_LABELS[r.rank] ?? r.rank,
    bottles,
    sales,
  });
  const topSellers = resellers
    .map((r) => ({ r, s: snapshot.stats.get(r.id)! }))
    .filter((x) => x.s.personalBottles > 0)
    .sort((a, b) => b.s.personalBottles - a.s.personalBottles)
    .slice(0, 5)
    .map(({ r, s }) => seller(r, s.personalBottles, s.personalSales));
  const topTeams = resellers
    .map((r) => ({ r, s: snapshot.stats.get(r.id)! }))
    .filter((x) => x.s.teamBottles > 0)
    .sort((a, b) => b.s.teamBottles - a.s.teamBottles)
    .slice(0, 5)
    .map(({ r, s }) => seller(r, s.teamBottles, s.teamSales));

  const [[pendingApps], ledger, monthIncentives, [flags], [enquiries], daily] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(resellerApplicationsTable).where(inArray(resellerApplicationsTable.status, ["pending", "info_requested"])),
    db
      .select({ status: commissionLedgerTable.status, total: sql<string>`coalesce(sum(${commissionLedgerTable.amount}), 0)` })
      .from(commissionLedgerTable)
      .groupBy(commissionLedgerTable.status),
    db
      .select({ total: sql<string>`coalesce(sum(${commissionLedgerTable.amount}), 0)` })
      .from(commissionLedgerTable)
      .where(and(eq(commissionLedgerTable.period, period), inArray(commissionLedgerTable.status, ["pending", "approved", "paid"]))),
    db.select({ count: sql<number>`count(*)::int` }).from(fraudFlagsTable).where(eq(fraudFlagsTable.status, "open")),
    db.select({ count: sql<number>`count(*)::int` }).from(enquiriesTable).where(eq(enquiriesTable.status, "new")),
    Promise.all(
      Array.from({ length: 14 }, (_, i) => {
        const start = new Date(today.getTime() - (13 - i) * DAY);
        return salesBetween(start, new Date(start.getTime() + DAY)).then((s) => ({ label: sastDateLabel(start).slice(5), value: s.revenue }));
      }),
    ),
  ]);
  const ledgerTotal = (status: string) => round2(Number(ledger.find((l) => l.status === status)?.total ?? 0));
  const incentivesMonth = round2(Number(monthIncentives[0]?.total ?? 0));
  const [awaiting] = await db.select({ count: sql<number>`count(*)::int` }).from(ordersTable).where(eq(ordersTable.status, "awaiting_payment"));

  const contribution = round2(month.revenue - month.cost - incentivesMonth);
  const perBottle = month.bottles > 0 ? contribution / month.bottles : 0;
  const bottlesRequired = perBottle > 0 ? Math.ceil(settings.monthlyContributionTarget / perBottle) : 0;

  res.json(
    GetAdminSummaryResponse.parse({
      period,
      sales: {
        today: day.revenue,
        week: week.revenue,
        month: month.revenue,
        lastMonth: monthly[monthly.length - 2]?.value ?? 0,
        year: year.revenue,
        retailMonth: month.retail,
        resellerMonth: month.reseller,
        wholesaleMonth: month.wholesale,
        ordersToday: day.orders,
        ordersMonth: month.orders,
        awaitingPayment: awaiting?.count ?? 0,
      },
      products: {
        unitsSold: month.bottles,
        revenue: month.revenue,
        cost: month.cost,
        grossProfit: round2(month.revenue - month.cost),
        stockUnits: products.reduce((s, p) => s + p.stockQuantity, 0),
        activeProducts: products.filter((p) => p.status === "active").length,
        bestSellers: [...performance].sort((a, b) => b.units - a.units).slice(0, 5),
        slowSellers: [...performance].sort((a, b) => a.units - b.units).slice(0, 5),
        lowStock: lowStock.slice(0, 10),
      },
      resellers: {
        total: resellers.length,
        approved: resellers.filter((r) => r.standing !== "suspended").length,
        active: resellers.filter((r) => snapshot.stats.get(r.id)?.isActive).length,
        inactive: resellers.filter((r) => !snapshot.stats.get(r.id)?.isActive).length,
        newThisMonth: resellers.filter((r) => r.approvedAt >= monthStart).length,
        pendingApplications: pendingApps?.count ?? 0,
        topSellers,
        topTeams,
      },
      organisation: {
        teamLeaders: resellers.filter((r) => r.rank === "team_leader").length,
        managers: resellers.filter((r) => r.rank === "manager").length,
        directors: resellers.filter((r) => r.rank === "director").length,
        teamVolume: resellers.reduce((s, r) => s + (snapshot.stats.get(r.id)?.personalBottles ?? 0), 0),
        incentivesMonth,
        incentivesPending: ledgerTotal("pending"),
        incentivesApproved: ledgerTotal("approved"),
        incentivesPaid: ledgerTotal("paid"),
      },
      contribution: {
        current: contribution,
        target: settings.monthlyContributionTarget,
        percent: settings.monthlyContributionTarget > 0 ? Math.round((contribution / settings.monthlyContributionTarget) * 100) : 0,
        bottlesSold: month.bottles,
        bottlesRequired,
        remaining: Math.max(0, bottlesRequired - month.bottles),
      },
      dailySales: daily,
      monthlySales: monthly,
      alerts: { openFraudFlags: flags?.count ?? 0, newEnquiries: enquiries?.count ?? 0, lowStock: lowStock.length },
    }),
  );
});

// ------------------------------------------------------------------ settings & content

router.get("/admin/settings", async (_req, res) => {
  res.json(GetAdminSettingsResponse.parse(await getSettings()));
});

router.patch("/admin/settings", async (req, res) => {
  const patch = UpdateAdminSettingsBody.parse(req.body);
  const before = await getSettings();
  const row = await updateSettings(patch);
  const changes = Object.fromEntries(
    Object.entries(patch)
      .filter(([key, value]) => before[key as keyof typeof before] !== value)
      .map(([key, value]) => [key, { from: before[key as keyof typeof before], to: value }]),
  );
  await audit("compensation_settings_updated", "compensation_settings", 1, req.currentUser, changes);
  res.json(UpdateAdminSettingsResponse.parse(row));
});

router.put("/admin/site-content", async (req, res) => {
  const content = UpdateSiteContentBody.parse(req.body);
  for (const [key, value] of Object.entries(content)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) throw badRequest(`Invalid content key "${key}"`);
    await db
      .insert(siteContentTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: siteContentTable.key, set: { value, updatedAt: new Date() } });
  }
  await audit("site_content_updated", "site_content", null, req.currentUser, { keys: Object.keys(content) });
  res.json(UpdateSiteContentResponse.parse(await siteContent()));
});

// ------------------------------------------------------------------ applications

async function applicationView(app: typeof resellerApplicationsTable.$inferSelect) {
  let sponsorName: string | null = null;
  if (app.referringCode) {
    const [sponsor] = await db
      .select({ firstName: usersTable.firstName, surname: usersTable.surname, code: resellersTable.resellerCode })
      .from(resellersTable)
      .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId))
      .where(or(eq(resellersTable.referralCode, app.referringCode), eq(resellersTable.resellerCode, app.referringCode)));
    sponsorName = sponsor ? `${sponsor.firstName} ${sponsor.surname} (${sponsor.code})` : "Unknown code";
  }
  return {
    id: app.id,
    applicationId: app.applicationId,
    name: `${app.firstName} ${app.surname}`,
    email: app.email,
    mobile: app.mobile,
    province: app.province,
    city: app.city,
    contactMethod: app.contactMethod,
    heardAbout: app.heardAbout,
    referringCode: app.referringCode,
    sponsorName,
    status: app.status,
    adminNote: app.adminNote,
    createdAt: app.createdAt.toISOString(),
    warnings: app.status === "approved" ? [] : await duplicateIdentityWarnings({ email: app.email, mobile: app.mobile, excludeApplicationId: app.id }),
  };
}

router.get("/admin/applications", async (req, res) => {
  const { status } = ListAdminApplicationsQueryParams.parse(req.query);
  const rows = await db
    .select()
    .from(resellerApplicationsTable)
    .where(status ? eq(resellerApplicationsTable.status, status) : undefined)
    .orderBy(desc(resellerApplicationsTable.createdAt))
    .limit(200);
  res.json(ListAdminApplicationsResponse.parse(await Promise.all(rows.map(applicationView))));
});

router.post("/admin/applications/:id/decision", async (req, res) => {
  const { id } = DecideApplicationParams.parse(req.params);
  const { decision, note } = DecideApplicationBody.parse(req.body);
  const admin = req.currentUser!;
  const [app] = await db.select().from(resellerApplicationsTable).where(eq(resellerApplicationsTable.id, id));
  if (!app) throw notFound("Application not found");
  if (app.status === "approved") throw badRequest("This application has already been approved.");

  if (decision === "approve") {
    const email = app.email.toLowerCase();
    const [user] = await db
      .insert(usersTable)
      .values({ email, role: "reseller", firstName: app.firstName, surname: app.surname, mobile: app.mobile, city: app.city, province: app.province })
      .onConflictDoUpdate({
        target: usersTable.email,
        set: { role: sql`case when ${usersTable.role} = 'admin' then 'admin' else 'reseller' end`, mobile: sql`coalesce(${usersTable.mobile}, ${app.mobile})` },
      })
      .returning();
    const [existing] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.userId, user!.id));
    if (existing) throw new HttpError(409, "This person is already a reseller.");
    let sponsorId: number | null = null;
    if (app.referringCode) {
      const [sponsor] = await db
        .select()
        .from(resellersTable)
        .where(or(eq(resellersTable.referralCode, app.referringCode), eq(resellersTable.resellerCode, app.referringCode)));
      if (sponsor && sponsor.userId !== user!.id) sponsorId = sponsor.id;
    }
    let reseller: Reseller | undefined;
    for (let attempt = 0; attempt < 8 && !reseller; attempt++) {
      try {
        [reseller] = await db
          .insert(resellersTable)
          .values({
            userId: user!.id,
            applicationId: app.id,
            resellerCode: `TMP-${randomCode(10)}`,
            referralCode: referralCodeFor(app.firstName),
            sponsorId,
          })
          .returning();
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    if (!reseller) throw new Error("Could not allocate a referral code");
    [reseller] = await db.update(resellersTable).set({ resellerCode: resellerCodeFor(reseller.id) }).where(eq(resellersTable.id, reseller.id)).returning();
    await db
      .update(resellerApplicationsTable)
      .set({ status: "approved", userId: user!.id, adminNote: note ?? null, reviewedBy: admin.id, reviewedAt: new Date() })
      .where(eq(resellerApplicationsTable.id, id));
    const settings = await getSettings();
    await notifyUser(
      user!.id,
      "reseller_approved",
      "Welcome — you're an approved Mas'Mila reseller",
      `Your reseller ID is ${reseller!.resellerCode} and your referral code is ${reseller!.referralCode}. Sign in with ${email} to see reseller pricing and place your opening order of ${settings.openingOrder} bottles.`,
      "/account/reseller",
    );
    if (sponsorId) {
      const [sponsor] = await db.select().from(resellersTable).where(eq(resellersTable.id, sponsorId));
      await notifyUser(sponsor!.userId, "new_team_member", "New team member", `${app.firstName} ${app.surname} joined your team. Help them place their opening order.`, "/account/reseller?tab=team");
    }
    await audit("reseller_application_approved", "reseller_application", app.applicationId, admin, { resellerCode: reseller!.resellerCode, sponsorId });
  } else {
    const status = decision === "reject" ? "rejected" : "info_requested";
    await db
      .update(resellerApplicationsTable)
      .set({ status, adminNote: note ?? null, reviewedBy: admin.id, reviewedAt: new Date() })
      .where(eq(resellerApplicationsTable.id, id));
    const message =
      decision === "reject"
        ? `Thank you for applying to become a Mas'Mila reseller. We are unable to approve application ${app.applicationId} at this time.${note ? ` ${note}` : ""}`
        : `We need a little more information about your reseller application ${app.applicationId}: ${note ?? "please contact us."} Reply to this email or WhatsApp us.`;
    await notifyEmail(app.email, decision === "reject" ? "Reseller application update" : "More information needed", message);
    if (app.userId) await notifyUser(app.userId, `application_${status}`, "Reseller application update", message, "/account");
    await audit(`reseller_application_${status}`, "reseller_application", app.applicationId, admin, { note });
  }
  const [updated] = await db.select().from(resellerApplicationsTable).where(eq(resellerApplicationsTable.id, id));
  res.json(DecideApplicationResponse.parse(await applicationView(updated!)));
});

// ------------------------------------------------------------------ resellers, customers, teams

async function resellerViews(filter?: SQL) {
  const rows = await db
    .select({ reseller: resellersTable, user: usersTable })
    .from(resellersTable)
    .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId))
    .where(filter)
    .orderBy(resellersTable.id);
  const snapshot = await evaluatePeriod(currentPeriod());
  const names = await resellerNames(rows.map((r) => r.reseller.sponsorId).filter((x): x is number => x != null));
  return rows.map(({ reseller: r, user: u }) => {
    const s = snapshot.stats.get(r.id);
    return {
      id: r.id,
      resellerCode: r.resellerCode,
      referralCode: r.referralCode,
      name: `${u.firstName} ${u.surname}`.trim() || u.email,
      email: u.email,
      mobile: u.mobile,
      rank: r.rank,
      rankLocked: r.rankLocked,
      status: s?.isActive ? "active" : "inactive",
      standing: r.standing,
      sponsor: r.sponsorId != null ? (names.get(r.sponsorId)?.name ?? null) : null,
      sponsorCode: r.sponsorId != null ? (names.get(r.sponsorId)?.code ?? null) : null,
      openingOrderCompleted: r.openingOrderCompleted,
      personalBottles: s?.personalBottles ?? 0,
      teamBottles: s?.teamBottles ?? 0,
      directs: snapshot.children.get(r.id)?.length ?? 0,
      approvedAt: r.approvedAt.toISOString(),
      lastOrderAt: iso(r.lastOrderAt),
    };
  });
}

router.get("/admin/resellers", async (req, res) => {
  const { search } = ListAdminResellersQueryParams.parse(req.query);
  const like = search?.trim() ? `%${search.trim()}%` : null;
  const filter = like
    ? or(ilike(resellersTable.resellerCode, like), ilike(resellersTable.referralCode, like), ilike(usersTable.email, like), ilike(usersTable.firstName, like), ilike(usersTable.surname, like))
    : undefined;
  res.json(ListAdminResellersResponse.parse(await resellerViews(filter)));
});

router.patch("/admin/resellers/:id", async (req, res) => {
  const { id } = UpdateAdminResellerParams.parse(req.params);
  const patch = UpdateAdminResellerBody.parse(req.body);
  const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.id, id));
  if (!reseller) throw notFound("Reseller not found");
  const changes: Partial<Reseller> = {};
  if (patch.standing) changes.standing = patch.standing;
  if (patch.rank) {
    changes.rank = patch.rank;
    changes.rankWarningMonths = 0;
  }
  if (patch.rankLocked !== undefined) changes.rankLocked = patch.rankLocked;
  if (patch.sponsorCode !== undefined) {
    const code = patch.sponsorCode?.trim().toUpperCase() || null;
    if (!code) changes.sponsorId = null;
    else {
      const [sponsor] = await db.select().from(resellersTable).where(or(eq(resellersTable.resellerCode, code), eq(resellersTable.referralCode, code)));
      if (!sponsor) throw badRequest(`No reseller with code ${code}.`);
      // Prevent cycles: the new sponsor may not be this reseller or anyone in their downline.
      const all = await db.select({ id: resellersTable.id, sponsorId: resellersTable.sponsorId }).from(resellersTable);
      const parent = new Map(all.map((r) => [r.id, r.sponsorId]));
      for (let cursor: number | null = sponsor.id, hops = 0; cursor != null && hops < 10000; cursor = parent.get(cursor) ?? null, hops++) {
        if (cursor === id) throw badRequest("That sponsor is in this reseller's own downline.");
      }
      changes.sponsorId = sponsor.id;
    }
  }
  if (Object.keys(changes).length) {
    await db.update(resellersTable).set(changes).where(eq(resellersTable.id, id));
    await audit("reseller_updated", "reseller", reseller.resellerCode, req.currentUser, {
      before: { standing: reseller.standing, rank: reseller.rank, rankLocked: reseller.rankLocked, sponsorId: reseller.sponsorId },
      after: changes,
    });
    if (changes.standing && changes.standing !== reseller.standing) {
      await notifyUser(reseller.userId, "account_status", "Account status updated", `Your reseller account standing is now "${changes.standing}".${changes.standing === "good" ? "" : " Please contact Mas'Mila if you have questions."}`, "/account/reseller");
    }
    if (changes.rank && changes.rank !== reseller.rank) {
      await notifyUser(reseller.userId, "rank_achieved", `Rank updated: ${RANK_LABELS[changes.rank]}`, `Mas'Mila updated your rank to ${RANK_LABELS[changes.rank]}.`, "/account/reseller");
    }
  }
  const [view] = await resellerViews(eq(resellersTable.id, id));
  res.json(UpdateAdminResellerResponse.parse(view));
});

async function customerViews(filter?: SQL) {
  const users = await db.select().from(usersTable).where(filter).orderBy(desc(usersTable.createdAt)).limit(300);
  if (!users.length) return [];
  const stats = await db
    .select({ email: ordersTable.customerEmail, orders: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${ordersTable.total}), 0)` })
    .from(ordersTable)
    .where(and(inArray(ordersTable.customerEmail, users.map((u) => u.email)), inArray(ordersTable.status, PAID_STATUSES)))
    .groupBy(ordersTable.customerEmail);
  const byEmail = new Map(stats.map((s) => [s.email, s]));
  const mobiles = users.map((u) => u.mobile).filter((m): m is string => Boolean(m));
  const sameMobile = mobiles.length
    ? await db.select({ email: usersTable.email, mobile: usersTable.mobile }).from(usersTable).where(inArray(usersTable.mobile, mobiles))
    : [];
  return users.map((u) => {
    const dup = sameMobile.find((m) => m.mobile === u.mobile && m.email !== u.email);
    return {
      id: u.id,
      name: `${u.firstName} ${u.surname}`.trim() || u.email,
      email: u.email,
      mobile: u.mobile,
      role: u.role,
      accountStatus: u.accountStatus,
      orders: byEmail.get(u.email)?.orders ?? 0,
      totalSpent: round2(Number(byEmail.get(u.email)?.total ?? 0)),
      createdAt: u.createdAt.toISOString(),
      duplicateOf: dup ? dup.email : null,
    };
  });
}

router.get("/admin/customers", async (req, res) => {
  const { search } = ListAdminCustomersQueryParams.parse(req.query);
  const like = search?.trim() ? `%${search.trim()}%` : null;
  res.json(
    ListAdminCustomersResponse.parse(
      await customerViews(like ? or(ilike(usersTable.email, like), ilike(usersTable.firstName, like), ilike(usersTable.surname, like), ilike(usersTable.mobile, like)) : undefined),
    ),
  );
});

router.patch("/admin/customers/:id", async (req, res) => {
  const { id } = UpdateAdminCustomerParams.parse(req.params);
  const patch = UpdateAdminCustomerBody.parse(req.body);
  if (id === req.currentUser!.id && (patch.role && patch.role !== "admin" || patch.accountStatus && patch.accountStatus !== "active")) {
    throw badRequest("You cannot remove your own admin access or suspend yourself.");
  }
  const [before] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!before) throw notFound("User not found");
  if (patch.role === "reseller") {
    const [r] = await db.select({ id: resellersTable.id }).from(resellersTable).where(eq(resellersTable.userId, id));
    if (!r) throw badRequest("Approve a reseller application to make someone a reseller.");
  }
  await db.update(usersTable).set(patch).where(eq(usersTable.id, id));
  await audit("user_updated", "user", id, req.currentUser, { before: { role: before.role, accountStatus: before.accountStatus }, after: patch });
  const [view] = await customerViews(eq(usersTable.id, id));
  res.json(UpdateAdminCustomerResponse.parse(view));
});

router.get("/admin/teams", async (_req, res) => {
  const snapshot = await evaluatePeriod(currentPeriod());
  const names = await resellerNames([...snapshot.resellers.keys()]);
  const nodes: unknown[] = [];
  const visit = (id: number, depth: number, seen: Set<number>) => {
    if (seen.has(id)) return;
    seen.add(id);
    const r = snapshot.resellers.get(id)!;
    const s = snapshot.stats.get(id)!;
    nodes.push({
      id,
      sponsorId: r.sponsorId,
      depth,
      resellerCode: r.resellerCode,
      name: names.get(id)?.name ?? r.resellerCode,
      rank: r.rank,
      status: s.isActive ? "active" : "inactive",
      standing: r.standing,
      personalBottles: s.personalBottles,
      teamBottles: s.teamBottles,
      orgBottles: s.orgBottles,
      directs: snapshot.children.get(id)?.length ?? 0,
    });
    const kids = [...(snapshot.children.get(id) ?? [])].sort((a, b) => rankValue(snapshot.resellers.get(b)!.rank) - rankValue(snapshot.resellers.get(a)!.rank));
    for (const kid of kids) visit(kid, depth + 1, seen);
  };
  const seen = new Set<number>();
  const roots = [...snapshot.resellers.values()]
    .filter((r) => r.sponsorId == null || !snapshot.resellers.has(r.sponsorId))
    .sort((a, b) => rankValue(b.rank) - rankValue(a.rank));
  for (const root of roots) visit(root.id, 0, seen);
  for (const id of snapshot.resellers.keys()) visit(id, 0, seen);
  res.json(ListAdminTeamsResponse.parse(nodes));
});

// ------------------------------------------------------------------ products

async function adminProducts(ids?: number[]) {
  const rows = await db.select().from(productsTable).where(ids ? inArray(productsTable.id, ids) : undefined).orderBy(productsTable.name, productsTable.size);
  const sold = await db
    .select({ productId: orderItemsTable.productId, units: sql<string>`sum(${orderItemsTable.quantity} - ${orderItemsTable.refundedQuantity})` })
    .from(orderItemsTable)
    .innerJoin(ordersTable, eq(ordersTable.id, orderItemsTable.orderId))
    .where(inArray(ordersTable.status, PAID_STATUSES))
    .groupBy(orderItemsTable.productId);
  const soldBy = new Map(sold.map((s) => [s.productId, Number(s.units)]));
  return rows.map((p: Product) => ({
    id: p.id,
    slug: p.slug,
    sku: p.sku,
    name: p.name,
    category: p.category,
    family: p.family,
    description: p.description,
    scentProfile: p.scentProfile,
    topNotes: p.topNotes,
    middleNotes: p.middleNotes,
    baseNotes: p.baseNotes,
    keywords: p.keywords,
    image: p.image,
    imageAlt: p.imageAlt,
    size: p.size,
    retailPrice: p.retailPrice,
    recommendedRetailPrice: p.recommendedRetailPrice,
    resellerPrice: p.resellerPrice,
    cost: p.cost,
    stockQuantity: p.stockQuantity,
    reservedQuantity: p.reservedQuantity,
    soldQuantity: soldBy.get(p.id) ?? 0,
    available: available(p),
    lowStockThreshold: p.lowStockThreshold,
    isBestSeller: p.isBestSeller,
    isNew: p.isNew,
    isFeatured: p.isFeatured,
    status: p.status,
    shopifyVariantId: p.shopifyVariantId,
  }));
}

router.get("/admin/products", async (_req, res) => {
  res.json(ListAdminProductsResponse.parse(await adminProducts()));
});

router.post("/admin/products", async (req, res) => {
  const input = CreateAdminProductBody.parse(req.body);
  try {
    const [row] = await db
      .insert(productsTable)
      .values({
        ...input,
        sku: input.sku.trim().toUpperCase(),
        slug: slugify(input.slug || `${input.name}-${input.size}`),
        recommendedRetailPrice: input.recommendedRetailPrice ?? input.retailPrice,
      })
      .returning();
    await audit("product_created", "product", row!.sku, req.currentUser, { retailPrice: row!.retailPrice, resellerPrice: row!.resellerPrice });
    const [view] = await adminProducts([row!.id]);
    res.status(201).json(CreateAdminProductResponse.parse(view));
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "A product with that SKU or URL already exists.");
    throw err;
  }
});

router.patch("/admin/products/:id", async (req, res) => {
  const { id } = UpdateAdminProductParams.parse(req.params);
  const patch = UpdateAdminProductBody.parse(req.body);
  const [before] = await db.select().from(productsTable).where(eq(productsTable.id, id));
  if (!before) throw notFound("Product not found");
  try {
    await db
      .update(productsTable)
      .set({ ...patch, ...(patch.sku ? { sku: patch.sku.trim().toUpperCase() } : {}), updatedAt: new Date() })
      .where(eq(productsTable.id, id));
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "Another product already uses that SKU.");
    throw err;
  }
  const changes = Object.fromEntries(
    Object.entries(patch)
      .filter(([k, v]) => JSON.stringify(before[k as keyof Product]) !== JSON.stringify(v))
      .map(([k, v]) => [k, { from: before[k as keyof Product], to: v }]),
  );
  await audit("product_updated", "product", before.sku, req.currentUser, changes);
  const [view] = await adminProducts([id]);
  res.json(UpdateAdminProductResponse.parse(view));
});

// ------------------------------------------------------------------ orders

router.get("/admin/orders", async (req, res) => {
  const { status, channel, search } = ListAdminOrdersQueryParams.parse(req.query);
  const filters: SQL[] = [];
  if (status) filters.push(eq(ordersTable.status, status));
  if (channel) filters.push(eq(ordersTable.channel, channel));
  if (search?.trim()) {
    const like = `%${search.trim()}%`;
    filters.push(or(ilike(ordersTable.orderNumber, like), ilike(ordersTable.customerEmail, like), ilike(ordersTable.customerSurname, like), ilike(ordersTable.customerFirstName, like))!);
  }
  const rows = await db.select().from(ordersTable).where(and(...filters)).orderBy(desc(ordersTable.createdAt)).limit(250);
  res.json(ListAdminOrdersResponse.parse(await serializeOrders(rows, { admin: true })));
});

router.patch("/admin/orders/:id", async (req, res) => {
  const { id } = UpdateAdminOrderParams.parse(req.params);
  const patch = UpdateAdminOrderBody.parse(req.body);
  await updateFulfilment(id, patch, req.currentUser!);
  res.json(UpdateAdminOrderResponse.parse(await getOrderView(id, { admin: true })));
});

router.post("/admin/orders/:id/refund", async (req, res) => {
  const { id } = RefundAdminOrderParams.parse(req.params);
  const input = RefundAdminOrderBody.parse(req.body);
  await refundOrder(id, input, req.currentUser!);
  res.json(RefundAdminOrderResponse.parse(await getOrderView(id, { admin: true })));
});

// ------------------------------------------------------------------ commissions & payouts

router.get("/admin/commissions", async (req, res) => {
  const { status, period } = ListAdminCommissionsQueryParams.parse(req.query);
  const filters: SQL[] = [];
  if (status) filters.push(eq(commissionLedgerTable.status, status));
  if (period) filters.push(eq(commissionLedgerTable.period, period));
  const rows = await db.select().from(commissionLedgerTable).where(and(...filters)).orderBy(desc(commissionLedgerTable.id)).limit(1000);
  res.json(ListAdminCommissionsResponse.parse(await serializeLedger(rows)));
});

router.post("/admin/commissions/approve", async (req, res) => {
  const { ids } = ApproveCommissionsBody.parse(req.body);
  // Accruals must be confirmed by a month-end qualification run first.
  const updated = await db
    .update(commissionLedgerTable)
    .set({ status: "approved", approvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(commissionLedgerTable.id, ids),
        eq(commissionLedgerTable.status, "pending"),
        or(eq(commissionLedgerTable.qualificationStatus, "qualified"), eq(commissionLedgerTable.entryType, "reversal")),
      ),
    )
    .returning();
  const byBeneficiary = new Map<number, number>();
  for (const row of updated) byBeneficiary.set(row.beneficiaryResellerId, (byBeneficiary.get(row.beneficiaryResellerId) ?? 0) + row.amount);
  for (const [resellerId, amount] of byBeneficiary) {
    const [r] = await db.select().from(resellersTable).where(eq(resellersTable.id, resellerId));
    if (r) await notifyUser(r.userId, "incentive_approved", "Incentive approved", `R${round2(amount).toFixed(2)} in incentives has been approved for payment.`, "/account/reseller?tab=incentives");
  }
  await audit("commissions_approved", "commission_ledger", null, req.currentUser, { ids: updated.map((r) => r.id), requested: ids.length });
  res.json({ count: updated.length });
});

async function payoutViews(ids?: number[]) {
  const rows = await db.select().from(payoutsTable).where(ids ? inArray(payoutsTable.id, ids) : undefined).orderBy(desc(payoutsTable.id)).limit(300);
  const names = await resellerNames(rows.map((p) => p.resellerId));
  return rows.map((p) => ({
    id: p.id,
    payoutNumber: p.payoutNumber,
    resellerName: names.get(p.resellerId)?.name ?? "",
    resellerCode: names.get(p.resellerId)?.code ?? "",
    amount: p.amount,
    entryCount: p.entryCount,
    reference: p.reference,
    createdAt: p.createdAt.toISOString(),
  }));
}

router.get("/admin/payouts", async (_req, res) => {
  res.json(ListAdminPayoutsResponse.parse(await payoutViews()));
});

router.post("/admin/payouts", async (req, res) => {
  const { resellerIds, reference } = CreatePayoutsBody.parse(req.body);
  const approved = await db
    .select()
    .from(commissionLedgerTable)
    .where(and(eq(commissionLedgerTable.status, "approved"), resellerIds?.length ? inArray(commissionLedgerTable.beneficiaryResellerId, resellerIds) : undefined));
  const byReseller = new Map<number, typeof approved>();
  for (const row of approved) byReseller.set(row.beneficiaryResellerId, [...(byReseller.get(row.beneficiaryResellerId) ?? []), row]);
  const created: number[] = [];
  for (const [resellerId, rows] of byReseller) {
    const amount = round2(rows.reduce((s, r) => s + r.amount, 0));
    // Net clawbacks larger than earnings carry forward to the next payout.
    if (amount <= 0) continue;
    const [r] = await db.select().from(resellersTable).where(eq(resellersTable.id, resellerId));
    const payoutNumber = `PO-${currentPeriod().replace("-", "")}-${r!.resellerCode.replace("MSM-", "")}-${randomCode(4)}`;
    const payout = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(payoutsTable)
        .values({ payoutNumber, resellerId, amount, entryCount: rows.length, reference: reference ?? null, createdBy: req.currentUser!.id })
        .returning();
      await tx
        .update(commissionLedgerTable)
        .set({ status: "paid", paidAt: new Date(), payoutId: p!.id, updatedAt: new Date() })
        .where(and(inArray(commissionLedgerTable.id, rows.map((x) => x.id)), eq(commissionLedgerTable.status, "approved")));
      return p!;
    });
    created.push(payout.id);
    await notifyUser(r!.userId, "incentive_paid", "Incentive paid", `R${amount.toFixed(2)} has been paid to you (${payoutNumber}).`, "/account/reseller?tab=incentives");
    await audit("payout_created", "payout", payoutNumber, req.currentUser, { resellerId, amount, entries: rows.length, reference });
  }
  res.json(CreatePayoutsResponse.parse(created.length ? await payoutViews(created) : []));
});

// ------------------------------------------------------------------ qualification

async function qualificationResult(period: string) {
  const [run] = await db.select().from(periodRunsTable).where(eq(periodRunsTable.period, period));
  const [ledger] = await db
    .select({
      qualified: sql<number>`count(*) filter (where ${commissionLedgerTable.qualificationStatus} = 'qualified')::int`,
      voided: sql<number>`count(*) filter (where ${commissionLedgerTable.qualificationStatus} = 'not_qualified')::int`,
    })
    .from(commissionLedgerTable)
    .where(and(eq(commissionLedgerTable.period, period), eq(commissionLedgerTable.entryType, "accrual")));
  let rows: Array<{ resellerId: number; resellerCode: string; name: string; personalBottles: number; teamBottles: number; orgBottles: number; activeDirects: number; activeTeamLeaders: number; orgActiveResellers: number; isActive: boolean; qualifiedRank: string; rankBefore: string; rankAfter: string; warning: boolean }>;
  if (run) {
    const snaps = await db.select().from(qualificationPeriodsTable).where(eq(qualificationPeriodsTable.period, period));
    const names = await resellerNames(snaps.map((s) => s.resellerId));
    rows = snaps.map((s) => ({ ...s, resellerCode: names.get(s.resellerId)?.code ?? "", name: names.get(s.resellerId)?.name ?? "" }));
  } else {
    // Preview: what the run would decide, without applying it.
    const snapshot = await evaluatePeriod(period);
    const names = await resellerNames([...snapshot.resellers.keys()]);
    rows = [...snapshot.resellers.values()].map((r) => {
      const s = snapshot.stats.get(r.id)!;
      return { resellerId: r.id, resellerCode: r.resellerCode, name: names.get(r.id)?.name ?? "", personalBottles: s.personalBottles, teamBottles: s.teamBottles, orgBottles: s.orgBottles, activeDirects: s.activeDirects, activeTeamLeaders: s.activeTeamLeaders, orgActiveResellers: s.orgActiveResellers, isActive: s.isActive, qualifiedRank: s.qualifiedRank, rankBefore: r.rank, rankAfter: r.rank, warning: false };
    });
  }
  rows.sort((a, b) => rankValue(b.qualifiedRank) - rankValue(a.qualifiedRank) || b.orgBottles - a.orgBottles);
  return {
    period,
    status: run ? run.status : "preview",
    runAt: iso(run?.runAt),
    promotions: rows.filter((r) => rankValue(r.rankAfter) > rankValue(r.rankBefore)).length,
    demotions: rows.filter((r) => rankValue(r.rankAfter) < rankValue(r.rankBefore)).length,
    warnings: rows.filter((r) => r.warning).length,
    activeResellers: rows.filter((r) => r.isActive).length,
    ledgerQualified: ledger?.qualified ?? 0,
    ledgerVoided: ledger?.voided ?? 0,
    rows,
  };
}

router.get("/admin/qualification", async (req, res) => {
  const { period } = GetQualificationQueryParams.parse(req.query);
  res.json(GetQualificationResponse.parse(await qualificationResult(period && /^\d{4}-\d{2}$/.test(period) ? period : previousPeriod(currentPeriod()))));
});

router.post("/admin/qualification", async (req, res) => {
  const { period } = RunQualificationBody.parse(req.body);
  if (period > currentPeriod()) throw badRequest("You cannot run qualification for a future month.");
  await runQualification(period, req.currentUser!);
  res.json(RunQualificationResponse.parse(await qualificationResult(period)));
});

// ------------------------------------------------------------------ fraud, enquiries, marketing, audit

async function fraudViews(ids?: number[]) {
  const rows = await db
    .select({ flag: fraudFlagsTable, orderNumber: ordersTable.orderNumber, userEmail: usersTable.email, resellerCode: resellersTable.resellerCode })
    .from(fraudFlagsTable)
    .leftJoin(ordersTable, eq(ordersTable.id, fraudFlagsTable.orderId))
    .leftJoin(usersTable, eq(usersTable.id, fraudFlagsTable.userId))
    .leftJoin(resellersTable, eq(resellersTable.id, fraudFlagsTable.resellerId))
    .where(ids ? inArray(fraudFlagsTable.id, ids) : undefined)
    .orderBy(sql`case when ${fraudFlagsTable.status} = 'open' then 0 else 1 end`, desc(fraudFlagsTable.createdAt))
    .limit(300);
  return rows.map(({ flag, orderNumber, userEmail, resellerCode }) => ({
    id: flag.id,
    type: flag.type,
    severity: flag.severity,
    detail: flag.detail,
    status: flag.status,
    createdAt: flag.createdAt.toISOString(),
    resellerId: flag.resellerId,
    resellerCode,
    orderNumber,
    userId: flag.userId,
    userEmail,
  }));
}

router.get("/admin/fraud-flags", async (_req, res) => {
  res.json(ListFraudFlagsResponse.parse(await fraudViews()));
});

router.patch("/admin/fraud-flags/:id", async (req, res) => {
  const { id } = UpdateFraudFlagParams.parse(req.params);
  const { status } = UpdateFraudFlagBody.parse(req.body);
  if (!["open", "resolved", "dismissed"].includes(status)) throw badRequest("Status must be open, resolved or dismissed.");
  const [row] = await db
    .update(fraudFlagsTable)
    .set({ status, resolvedAt: status === "open" ? null : new Date() })
    .where(eq(fraudFlagsTable.id, id))
    .returning();
  if (!row) throw notFound("Flag not found");
  await audit(`fraud_flag_${status}`, "fraud_flag", id, req.currentUser);
  const [view] = await fraudViews([id]);
  res.json(UpdateFraudFlagResponse.parse(view));
});

const enquiryView = (e: typeof enquiriesTable.$inferSelect) => ({ ...e, createdAt: e.createdAt.toISOString() });

router.get("/admin/enquiries", async (_req, res) => {
  const rows = await db.select().from(enquiriesTable).orderBy(desc(enquiriesTable.createdAt)).limit(300);
  res.json(ListAdminEnquiriesResponse.parse(rows.map(enquiryView)));
});

router.patch("/admin/enquiries/:id", async (req, res) => {
  const { id } = UpdateAdminEnquiryParams.parse(req.params);
  const { status } = UpdateAdminEnquiryBody.parse(req.body);
  if (!["new", "in_progress", "closed"].includes(status)) throw badRequest("Status must be new, in_progress or closed.");
  const [row] = await db.update(enquiriesTable).set({ status }).where(eq(enquiriesTable.id, id)).returning();
  if (!row) throw notFound("Enquiry not found");
  await audit("enquiry_updated", "enquiry", id, req.currentUser, { status });
  res.json(UpdateAdminEnquiryResponse.parse(enquiryView(row)));
});

router.get("/admin/marketing-materials", async (_req, res) => {
  const rows = await db.select().from(marketingMaterialsTable).orderBy(marketingMaterialsTable.category, marketingMaterialsTable.title);
  res.json(ListAdminMarketingMaterialsResponse.parse(rows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }))));
});

router.post("/admin/marketing-materials", async (req, res) => {
  const input = CreateMarketingMaterialBody.parse(req.body);
  if (!/^(https?:\/\/|\/api\/files\/)/i.test(input.url)) throw badRequest("Materials must be an uploaded file or a link starting with https://");
  const [row] = await db
    .insert(marketingMaterialsTable)
    .values({ ...input, description: input.description ?? "", minRank: input.minRank && rankValue(input.minRank) >= 0 ? input.minRank : "reseller" })
    .returning();
  await audit("marketing_material_created", "marketing_material", row!.id, req.currentUser, { title: row!.title });
  res.status(201).json(CreateMarketingMaterialResponse.parse({ ...row!, createdAt: row!.createdAt.toISOString() }));
});

router.patch("/admin/marketing-materials/:id", async (req, res) => {
  const { id } = UpdateMarketingMaterialParams.parse(req.params);
  const patch = UpdateMarketingMaterialBody.parse(req.body);
  if (patch.url && !/^(https?:\/\/|\/api\/files\/)/i.test(patch.url)) throw badRequest("Materials must be an uploaded file or a link starting with https://");
  if (patch.minRank && !["reseller", "team_leader", "manager", "director"].includes(patch.minRank)) throw badRequest("Unknown rank.");
  const [row] = await db.update(marketingMaterialsTable).set(patch).where(eq(marketingMaterialsTable.id, id)).returning();
  if (!row) throw notFound("Material not found");
  await audit("marketing_material_updated", "marketing_material", id, req.currentUser, { fields: Object.keys(patch) });
  res.json(UpdateMarketingMaterialResponse.parse({ ...row, createdAt: row.createdAt.toISOString() }));
});

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const UPLOAD_TYPES = /^(image\/(png|jpe?g|webp|gif|svg\+xml)|application\/pdf|text\/csv|application\/vnd\.(ms-excel|openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document|presentationml\.presentation))|video\/mp4)$/;

router.post("/admin/files", async (req, res) => {
  const input = UploadFileBody.parse(req.body);
  if (!UPLOAD_TYPES.test(input.contentType)) throw badRequest("Upload images, PDFs, spreadsheets, documents, slides or MP4 video.");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length) throw badRequest("The file is empty.");
  if (bytes.length > MAX_UPLOAD_BYTES) throw badRequest("Files can be up to 4 MB. Link larger files (e.g. videos) from Google Drive or YouTube instead.");
  const [row] = await db
    .insert(uploadedFilesTable)
    .values({ token: randomBytes(18).toString("base64url"), name: input.name.slice(0, 200), contentType: input.contentType, size: bytes.length, data: bytes.toString("base64"), uploadedBy: req.currentUser!.id })
    .returning({ id: uploadedFilesTable.id, token: uploadedFilesTable.token, name: uploadedFilesTable.name, size: uploadedFilesTable.size });
  await audit("file_uploaded", "file", row!.id, req.currentUser, { name: row!.name, size: row!.size, contentType: input.contentType });
  res.status(201).json(UploadFileResponse.parse({ ...row!, url: `/api/files/${row!.id}/${row!.token}` }));
});

router.post("/admin/announcements", async (req, res) => {
  const input = SendAnnouncementBody.parse(req.body);
  const filters: SQL[] = [eq(usersTable.accountStatus, "active")];
  if (input.audience === "customers") {
    filters.push(eq(usersTable.role, "customer"));
    // POPIA: promotional messages only to customers who opted in.
    if (input.marketingOnly !== false) filters.push(eq(usersTable.marketingOptIn, true));
  }
  const base = db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable);
  const recipients =
    input.audience === "resellers" || input.audience === "team_leaders" || input.audience === "managers"
      ? await base
          .innerJoin(resellersTable, eq(resellersTable.userId, usersTable.id))
          .where(
            and(
              ...filters,
              sql`${resellersTable.standing} <> 'suspended'`,
              input.audience === "team_leaders"
                ? inArray(resellersTable.rank, ["team_leader", "manager", "director"])
                : input.audience === "managers"
                  ? inArray(resellersTable.rank, ["manager", "director"])
                  : undefined,
            ),
          )
      : await base.where(and(...filters));
  const count = await notifyMany(recipients, "announcement", input.title, input.body, input.link ?? undefined);
  await audit("announcement_sent", "announcement", null, req.currentUser, { audience: input.audience, title: input.title, recipients: count });
  res.json({ count });
});

router.delete("/admin/marketing-materials/:id", async (req, res) => {
  const { id } = DeleteMarketingMaterialParams.parse(req.params);
  await db.delete(marketingMaterialsTable).where(eq(marketingMaterialsTable.id, id));
  await audit("marketing_material_deleted", "marketing_material", id, req.currentUser);
  res.json({ ok: true });
});

router.get("/admin/audit-logs", async (req, res) => {
  const { entityType } = ListAuditLogsQueryParams.parse(req.query);
  const rows = await db
    .select()
    .from(auditLogsTable)
    .where(entityType ? eq(auditLogsTable.entityType, entityType) : undefined)
    .orderBy(desc(auditLogsTable.id))
    .limit(300);
  res.json(ListAuditLogsResponse.parse(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))));
});

router.get("/admin/reports", async (req, res) => {
  const { type, from, to, format } = GetAdminReportQueryParams.parse(req.query);
  let report;
  try {
    report = await buildReport(type as ReportType, from, to);
  } catch (err) {
    if (err instanceof Error && err.message === "Invalid date range") throw badRequest("Choose a valid date range.");
    throw err;
  }
  await audit("report_exported", "report", type, req.currentUser, { from, to, format: format ?? "json" });
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="masmila-${type}-${sastDateLabel(new Date())}.csv"`);
    res.send(toCsv(report));
    return;
  }
  res.json(GetAdminReportResponse.parse(report));
});

export default router;
