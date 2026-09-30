import { Router, type IRouter } from "express";
import {
  GetResellerDashboardResponse,
  GetResellerOrganisationResponse,
  ListMarketingMaterialsResponse,
  ListResellerIncentivesResponse,
  ListResellerSalesResponse,
  ListResellerTeamResponse,
} from "@workspace/api-zod";
import {
  db,
  commissionLedgerTable,
  marketingMaterialsTable,
  notificationsTable,
  ordersTable,
  referralVisitsTable,
  resellersTable,
  usersTable,
  type LedgerEntry,
} from "@workspace/db";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { requireReseller } from "../lib/auth";
import { RANK_LABELS, rankValue, requirementProgress, type MemberStats } from "../lib/engine";
import { evaluatePeriod, PAID_STATUSES, resellerNames, type NetworkSnapshot } from "../lib/network";
import { currentPeriod, shiftPeriod } from "../lib/period";
import { forbidden, iso, round2 } from "../lib/http";
import { serializeOrders } from "../lib/orders";
import type { Settings } from "../lib/settings";

const router: IRouter = Router();
router.use(["/reseller", "/marketing-materials"], requireReseller);

const siteUrl = () => (process.env.SITE_URL ?? "https://masmila.co.za").replace(/\/$/, "");

function requirementsFor(rank: string, s: MemberStats, settings: Settings) {
  const tl = [
    { label: "Active direct resellers", current: s.activeDirects, target: settings.tlActiveDirects },
    { label: "Personal bottles this month", current: s.personalBottles, target: settings.personalTarget },
    { label: "Qualifying team bottles this month", current: s.teamBottles, target: settings.teamTarget },
  ];
  const mgr = [
    { label: "Active Team Leaders", current: s.activeTeamLeaders, target: settings.mgrActiveTeamLeaders },
    { label: "Active resellers in organisation", current: s.orgActiveResellers, target: settings.mgrActiveResellers },
    { label: "Organisation bottles this month", current: s.orgBottles, target: settings.mgrOrgBottles },
    { label: "Personal bottles this month", current: s.personalBottles, target: settings.mgrPersonalBottles },
  ];
  const dir = [
    { label: "Active Managers", current: s.activeManagers, target: settings.dirActiveManagers },
    { label: "Active resellers in organisation", current: s.orgActiveResellers, target: settings.dirActiveResellers },
    { label: "Organisation bottles this month", current: s.orgBottles, target: settings.dirOrgBottles },
  ];
  const value = rankValue(rank);
  const next = value === 0 ? { rank: "team_leader", reqs: tl } : value === 1 ? { rank: "manager", reqs: mgr } : value === 2 && settings.directorEnabled ? { rank: "director", reqs: dir } : null;
  const maintain = value === 1 ? tl : value === 2 ? mgr : value === 3 ? dir : [];
  const withMet = (list: typeof tl, prefix: string) => list.map((r) => ({ ...r, label: `${prefix}${r.label}`, met: r.current >= r.target }));
  return {
    nextRank: next ? RANK_LABELS[next.rank]! : null,
    progress: next ? requirementProgress(next.reqs) : requirementProgress(maintain),
    requirements: [
      ...withMet(maintain, maintain.length ? `Maintain ${RANK_LABELS[rank]} · ` : ""),
      ...(next ? withMet(next.reqs, `${RANK_LABELS[next.rank]} · `) : []),
    ],
  };
}

const LIVE = ["pending", "approved", "paid"];

async function incentiveTotals(resellerId: number, period: string) {
  const rows = await db
    .select({
      kind: commissionLedgerTable.kind,
      status: commissionLedgerTable.status,
      period: commissionLedgerTable.period,
      total: sql<string>`sum(${commissionLedgerTable.amount})`,
    })
    .from(commissionLedgerTable)
    .where(and(eq(commissionLedgerTable.beneficiaryResellerId, resellerId), inArray(commissionLedgerTable.status, LIVE)))
    .groupBy(commissionLedgerTable.kind, commissionLedgerTable.status, commissionLedgerTable.period);
  const sum = (filter: (r: (typeof rows)[number]) => boolean) => round2(rows.filter(filter).reduce((a, r) => a + Number(r.total), 0));
  return {
    teamThisMonth: sum((r) => r.period === period && r.kind === "team_leader"),
    orgThisMonth: sum((r) => r.period === period && (r.kind === "manager" || r.kind === "director")),
    pending: sum((r) => r.status === "pending"),
    approved: sum((r) => r.status === "approved"),
    paid: sum((r) => r.status === "paid"),
  };
}

function teamMember(snapshot: NetworkSnapshot, id: number, names: Map<number, { name: string; code: string; mobile: string | null }>) {
  const r = snapshot.resellers.get(id)!;
  const s = snapshot.stats.get(id)!;
  return {
    id,
    resellerCode: r.resellerCode,
    name: names.get(id)?.name ?? r.resellerCode,
    // Uplines can reach their own team members (e.g. a WhatsApp check-in).
    mobile: names.get(id)?.mobile ?? null,
    rank: RANK_LABELS[r.rank] ?? r.rank,
    status: s.isActive ? "Active" : "Inactive",
    standing: r.standing,
    personalBottles: s.personalBottles,
    personalSales: s.personalSales,
    teamBottles: s.teamBottles,
    directs: snapshot.children.get(id)?.length ?? 0,
    lastOrderAt: iso(r.lastOrderAt),
    joinedAt: r.approvedAt.toISOString(),
  };
}

router.get("/reseller/dashboard", async (req, res) => {
  const me = req.currentReseller!;
  const user = req.currentUser!;
  const period = currentPeriod();
  const snapshot = await evaluatePeriod(period);
  const { settings } = snapshot;
  const s = snapshot.stats.get(me.id)!;
  const rank = me.rank;
  const incentives = await incentiveTotals(me.id, period);
  const progress = requirementsFor(rank, s, settings);

  const [margin] = await db
    .select({
      retail: sql<string>`coalesce(sum(i.quantity * p.retail_price), 0)`,
      wholesale: sql<string>`coalesce(sum(i.quantity * i.unit_wholesale), 0)`,
    })
    .from(sql`order_items i join orders o on o.id = i.order_id join products p on p.id = i.product_id`)
    .where(sql`o.channel = 'reseller' and o.reseller_id = ${me.id} and o.period = ${period} and o.status in ${PAID_STATUSES}`);

  const [[visits], [conversions], recent] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(referralVisitsTable).where(eq(referralVisitsTable.resellerId, me.id)),
    db
      .select({ count: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${ordersTable.subtotal}), 0)` })
      .from(ordersTable)
      .where(and(eq(ordersTable.attributedResellerId, me.id), inArray(ordersTable.status, PAID_STATUSES))),
    db.select().from(notificationsTable).where(eq(notificationsTable.userId, user.id)).orderBy(desc(notificationsTable.createdAt)).limit(8),
  ]);

  let warning: string | null = null;
  if (me.standing === "hold" || me.standing === "review") warning = `Your account is under ${me.standing}. Incentives are withheld until Mas'Mila completes its review.`;
  else if (!me.openingOrderCompleted) warning = `Place your opening order of at least ${settings.openingOrder} bottles (mixed fragrances allowed) to activate your reseller account.`;
  else if (me.rankWarningMonths > 0) warning = `Coaching month: you did not meet the ${RANK_LABELS[rank]} requirements last month. Meet them this month to keep your ${RANK_LABELS[rank]} status.`;
  else if (!s.isActive) warning = `Your status is Inactive. Sell ${settings.reactivationBottles} bottles this month to reactivate — no rejoining fee.`;

  // Six-month trend (oldest first): volumes from each period's evaluation, incentives from the ledger.
  const periods = Array.from({ length: 6 }, (_, i) => shiftPeriod(period, i - 5));
  const [snapshots, ledgerByPeriod] = await Promise.all([
    Promise.all(periods.slice(0, -1).map((p) => evaluatePeriod(p, settings))),
    db
      .select({ period: commissionLedgerTable.period, total: sql<string>`sum(${commissionLedgerTable.amount})` })
      .from(commissionLedgerTable)
      .where(and(eq(commissionLedgerTable.beneficiaryResellerId, me.id), inArray(commissionLedgerTable.status, LIVE), inArray(commissionLedgerTable.period, periods)))
      .groupBy(commissionLedgerTable.period),
  ]);
  const incentiveFor = new Map(ledgerByPeriod.map((r) => [r.period, round2(Number(r.total))]));
  const history = periods.map((p, i) => {
    const stats = i === periods.length - 1 ? s : snapshots[i]!.stats.get(me.id);
    return {
      period: p,
      personalBottles: stats?.personalBottles ?? 0,
      teamBottles: stats?.teamBottles ?? 0,
      orgBottles: stats?.orgBottles ?? 0,
      incentive: incentiveFor.get(p) ?? 0,
    };
  });

  const firstName = user.firstName || "there";
  res.json(
    GetResellerDashboardResponse.parse({
      name: `${user.firstName} ${user.surname}`.trim() || user.email,
      firstName,
      rank: RANK_LABELS[rank] ?? rank,
      status: s.isActive ? "Active" : "Inactive",
      standing: me.standing,
      resellerCode: me.resellerCode,
      referralCode: me.referralCode,
      referralUrl: `${siteUrl()}/r/${me.referralCode}`,
      period,
      openingOrderRequired: settings.openingOrder,
      openingOrderCompleted: me.openingOrderCompleted,
      personal: {
        bottles: s.personalBottles,
        sales: s.personalSales,
        grossMargin: round2(Number(margin?.retail ?? 0) - Number(margin?.wholesale ?? 0)),
        target: settings.personalTarget,
        progress: Math.min(100, Math.round((s.personalBottles / Math.max(1, settings.personalTarget)) * 100)),
      },
      team: {
        activeResellers: s.activeDirects,
        inactiveResellers: s.inactiveDirects,
        bottles: s.teamBottles,
        sales: s.teamSales,
        target: settings.teamTarget,
        incentive: incentives.teamThisMonth,
        qualified: s.qualifiesTeamLeader,
      },
      organisation:
        rankValue(rank) >= 2
          ? {
              teamLeaders: s.activeTeamLeaders,
              activeResellers: s.orgActiveResellers,
              bottles: s.orgBottles,
              sales: s.orgSales,
              target: settings.mgrOrgBottles,
              incentive: incentives.orgThisMonth,
              qualified: s.qualifiesManager,
            }
          : null,
      nextRank: progress.nextRank,
      progress: progress.progress,
      requirements: progress.requirements,
      warning,
      incentives: { pending: incentives.pending, approved: incentives.approved, paid: incentives.paid },
      rates: {
        teamLeader: settings.teamLeaderRate,
        manager: settings.managerRate,
        director: settings.directorRate,
        directorEnabled: settings.directorEnabled,
      },
      activity: recent.map((n) => ({
        id: String(n.id),
        label: n.title,
        detail: n.body,
        time: n.createdAt.toISOString(),
        tone: n.type.includes("warning") || n.type.includes("revert") ? "warning" : n.type.includes("incentive") || n.type.includes("rank") ? "success" : "info",
      })),
      history,
      referralStats: {
        visits: visits?.count ?? 0,
        conversions: conversions?.count ?? 0,
        attributedSales: round2(Number(conversions?.total ?? 0)),
      },
    }),
  );
});

router.get("/reseller/team", async (req, res) => {
  const me = req.currentReseller!;
  const snapshot = await evaluatePeriod(currentPeriod());
  const ids = snapshot.children.get(me.id) ?? [];
  const names = await resellerNames(ids);
  res.json(ListResellerTeamResponse.parse(ids.map((id) => teamMember(snapshot, id, names))));
});

router.get("/reseller/organisation", async (req, res) => {
  const me = req.currentReseller!;
  if (rankValue(me.rank) < 2) throw forbidden("The organisation view is available to Managers.");
  const snapshot = await evaluatePeriod(currentPeriod());
  const descendants: number[] = [];
  const queue = [...(snapshot.children.get(me.id) ?? [])];
  const seen = new Set<number>([me.id]);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    descendants.push(id);
    queue.push(...(snapshot.children.get(id) ?? []));
  }
  const leaders = descendants.filter((id) => rankValue(snapshot.resellers.get(id)!.rank) >= 1);
  const names = await resellerNames(leaders);
  const mine = snapshot.stats.get(me.id)!;
  res.json(
    GetResellerOrganisationResponse.parse({
      teamLeaders: leaders.map((id) => teamMember(snapshot, id, names)),
      totalMembers: descendants.length,
      activeMembers: mine.orgActiveResellers,
      orgBottles: mine.orgBottles,
      orgSales: mine.orgSales,
    }),
  );
});

export async function serializeLedger(rows: LedgerEntry[]) {
  const names = await resellerNames(rows.flatMap((r) => [r.sellerResellerId, r.beneficiaryResellerId]));
  return rows.map((r) => ({
    id: r.id,
    entryType: r.entryType,
    orderNumber: r.orderNumber,
    period: r.period,
    productName: r.productName,
    quantity: r.quantity,
    seller: names.get(r.sellerResellerId)?.name ?? String(r.sellerResellerId),
    beneficiary: names.get(r.beneficiaryResellerId)?.name ?? String(r.beneficiaryResellerId),
    beneficiaryResellerCode: names.get(r.beneficiaryResellerId)?.code ?? "",
    kind: r.kind,
    beneficiaryRank: r.beneficiaryRank,
    rate: r.rate,
    baseValue: r.baseValue,
    amount: r.amount,
    qualificationStatus: r.qualificationStatus,
    status: r.status,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    paidAt: iso(r.paidAt),
  }));
}

router.get("/reseller/incentives", async (req, res) => {
  const rows = await db
    .select()
    .from(commissionLedgerTable)
    .where(eq(commissionLedgerTable.beneficiaryResellerId, req.currentReseller!.id))
    .orderBy(desc(commissionLedgerTable.createdAt))
    .limit(500);
  res.json(ListResellerIncentivesResponse.parse(await serializeLedger(rows)));
});

router.get("/reseller/sales", async (req, res) => {
  const orders = await db
    .select()
    .from(ordersTable)
    .where(and(eq(ordersTable.attributedResellerId, req.currentReseller!.id), notInArray(ordersTable.status, ["cancelled"])))
    .orderBy(desc(ordersTable.createdAt))
    .limit(200);
  // Resellers see enough to follow up, not full customer contact details.
  res.json(ListResellerSalesResponse.parse(await serializeOrders(orders, { maskCustomer: true })));
});

router.get("/marketing-materials", async (req, res) => {
  const rank = rankValue(req.currentReseller!.rank);
  const rows = await db.select().from(marketingMaterialsTable).orderBy(marketingMaterialsTable.category, marketingMaterialsTable.title);
  res.json(
    ListMarketingMaterialsResponse.parse(
      rows.filter((m) => rankValue(m.minRank) <= rank).map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    ),
  );
});

// Also used by the admin reseller listing.
export async function sponsorLookup() {
  return db
    .select({ id: resellersTable.id, code: resellersTable.resellerCode, firstName: usersTable.firstName, surname: usersTable.surname })
    .from(resellersTable)
    .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId));
}

export default router;
