import {
  db,
  commissionLedgerTable,
  orderItemsTable,
  ordersTable,
  periodRunsTable,
  qualificationPeriodsTable,
  resellersTable,
  usersTable,
  type Reseller,
} from "@workspace/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  RANK_LABELS,
  decideRank,
  evaluateNetwork,
  incentiveAmount,
  incentiveTargets,
  rankValue,
  type MemberStats,
  type NetworkMember,
  type Volume,
} from "./engine";
import { getSettings, type Settings } from "./settings";
import { currentPeriod, periodBounds, previousPeriod } from "./period";
import { audit } from "./audit";
import { notifyUser } from "./notify";
import { round2 } from "./http";

/** Order statuses whose product sales count towards volume and incentives. */
export const PAID_STATUSES = ["paid", "processing", "shipped", "delivered", "partially_refunded"];

/** Personal qualifying volume per reseller for a period (net of refunds, at wholesale value). */
export async function volumesForPeriod(period: string, settings: Settings): Promise<Map<number, Volume>> {
  const seller = settings.countAttributedRetail
    ? sql<number>`case when ${ordersTable.channel} = 'reseller' then ${ordersTable.resellerId} else ${ordersTable.attributedResellerId} end`
    : sql<number>`case when ${ordersTable.channel} = 'reseller' then ${ordersTable.resellerId} else null end`;
  const rows = await db
    .select({
      seller,
      bottles: sql<string>`sum(${orderItemsTable.quantity} - ${orderItemsTable.refundedQuantity})`,
      sales: sql<string>`sum((${orderItemsTable.quantity} - ${orderItemsTable.refundedQuantity}) * ${orderItemsTable.unitWholesale})`,
    })
    .from(ordersTable)
    .innerJoin(orderItemsTable, eq(orderItemsTable.orderId, ordersTable.id))
    .where(and(eq(ordersTable.period, period), inArray(ordersTable.status, PAID_STATUSES)))
    .groupBy(seller);
  const map = new Map<number, Volume>();
  for (const row of rows) {
    if (row.seller == null) continue;
    map.set(Number(row.seller), { bottles: Number(row.bottles), sales: round2(Number(row.sales)) });
  }
  return map;
}

/** Whether each reseller was active in the period before `period`. */
async function previousActivity(period: string, resellers: Reseller[]) {
  const prev = previousPeriod(period);
  const rows = await db
    .select({ resellerId: qualificationPeriodsTable.resellerId, isActive: qualificationPeriodsTable.isActive })
    .from(qualificationPeriodsTable)
    .where(eq(qualificationPeriodsTable.period, prev));
  const snapshot = new Map(rows.map((r) => [r.resellerId, r.isActive]));
  // No snapshot yet: fall back to the stored status (new resellers start inactive and
  // become active through their opening order).
  return new Map(resellers.map((r) => [r.id, snapshot.get(r.id) ?? r.status === "active"]));
}

export type NetworkSnapshot = {
  period: string;
  settings: Settings;
  resellers: Map<number, Reseller>;
  stats: Map<number, MemberStats>;
  children: Map<number, number[]>;
};

/** Live evaluation of the whole network for a period. */
export async function evaluatePeriod(period: string, settings?: Settings): Promise<NetworkSnapshot> {
  const s = settings ?? (await getSettings());
  const resellers = await db.select().from(resellersTable);
  const [volumes, wasActive] = await Promise.all([volumesForPeriod(period, s), previousActivity(period, resellers)]);
  const members: NetworkMember[] = resellers.map((r) => ({
    id: r.id,
    sponsorId: r.sponsorId,
    rank: r.rank,
    rankLocked: r.rankLocked,
    rankWarningMonths: r.rankWarningMonths,
    standing: r.standing,
    wasActive: wasActive.get(r.id) ?? false,
  }));
  const stats = evaluateNetwork(members, volumes, s);
  const children = new Map<number, number[]>();
  for (const r of resellers) {
    if (r.sponsorId == null) continue;
    children.set(r.sponsorId, [...(children.get(r.sponsorId) ?? []), r.id]);
  }
  return { period, settings: s, resellers: new Map(resellers.map((r) => [r.id, r])), stats, children };
}

const eligibleStanding = (standing: string | undefined) => standing === "good" || standing === "review";

type LedgerRowInput = typeof commissionLedgerTable.$inferInsert;

async function paidOrderLines(where: ReturnType<typeof and>) {
  return db
    .select({
      orderId: ordersTable.id,
      orderNumber: ordersTable.orderNumber,
      channel: ordersTable.channel,
      period: ordersTable.period,
      resellerId: ordersTable.resellerId,
      attributedResellerId: ordersTable.attributedResellerId,
      itemId: orderItemsTable.id,
      productName: orderItemsTable.name,
      quantity: orderItemsTable.quantity,
      refundedQuantity: orderItemsTable.refundedQuantity,
      unitPrice: orderItemsTable.unitPrice,
      unitWholesale: orderItemsTable.unitWholesale,
    })
    .from(ordersTable)
    .innerJoin(orderItemsTable, eq(orderItemsTable.orderId, ordersTable.id))
    .where(where);
}

type Line = Awaited<ReturnType<typeof paidOrderLines>>[number];

/** Expected ledger rows for order lines given a rank lookup. */
function expectedRows(
  lines: Line[],
  settings: Settings,
  ctx: { parentOf: (id: number) => number | null; rankOf: (id: number) => string; eligible: (id: number) => boolean },
  qualificationStatus: "provisional" | "qualified",
): LedgerRowInput[] {
  const rows: LedgerRowInput[] = [];
  for (const line of lines) {
    const net = line.quantity - line.refundedQuantity;
    if (net <= 0 || !line.period) continue;
    const base = round2(net * line.unitWholesale);
    const common = {
      orderId: line.orderId,
      orderItemId: line.itemId,
      orderNumber: line.orderNumber,
      period: line.period,
      productName: line.productName,
      quantity: net,
      qualificationStatus,
    };
    const seller =
      line.channel === "reseller"
        ? line.resellerId
        : settings.countAttributedRetail
          ? line.attributedResellerId
          : null;
    if (seller != null) {
      for (const target of incentiveTargets(seller, { ...ctx, settings })) {
        rows.push({
          ...common,
          sellerResellerId: seller,
          beneficiaryResellerId: target.beneficiaryId,
          kind: target.kind,
          beneficiaryRank: target.rank,
          rate: target.rate,
          baseValue: base,
          amount: incentiveAmount(base, target.rate),
        });
      }
    }
    // Optional commission for the reseller credited with an online retail sale.
    if (line.channel === "retail" && line.attributedResellerId != null && settings.referralRate > 0 && ctx.eligible(line.attributedResellerId)) {
      const retailBase = round2(net * line.unitPrice);
      rows.push({
        ...common,
        sellerResellerId: line.attributedResellerId,
        beneficiaryResellerId: line.attributedResellerId,
        kind: "referral",
        beneficiaryRank: ctx.rankOf(line.attributedResellerId),
        rate: settings.referralRate,
        baseValue: retailBase,
        amount: incentiveAmount(retailBase, settings.referralRate),
      });
    }
  }
  return rows;
}

/**
 * Provisional incentives the moment an order is paid, using current ranks,
 * so dashboards update in real time. The month-end run confirms or voids them.
 */
export async function accrueOrderIncentives(orderId: number) {
  const settings = await getSettings();
  const lines = await paidOrderLines(and(eq(ordersTable.id, orderId), inArray(ordersTable.status, PAID_STATUSES)));
  if (!lines.length) return [];
  const resellers = new Map((await db.select().from(resellersTable)).map((r) => [r.id, r]));
  const rows = expectedRows(lines, settings, {
    parentOf: (id) => resellers.get(id)?.sponsorId ?? null,
    rankOf: (id) => resellers.get(id)?.rank ?? "reseller",
    eligible: (id) => eligibleStanding(resellers.get(id)?.standing),
  }, "provisional");
  if (!rows.length) return [];
  // Unique index (order line, beneficiary, kind) makes this idempotent: no duplicate claims.
  const inserted = await db.insert(commissionLedgerTable).values(rows).onConflictDoNothing().returning();
  const byBeneficiary = new Map<number, number>();
  for (const row of inserted) byBeneficiary.set(row.beneficiaryResellerId, (byBeneficiary.get(row.beneficiaryResellerId) ?? 0) + row.amount);
  for (const [resellerId, amount] of byBeneficiary) {
    const reseller = resellers.get(resellerId);
    if (reseller) {
      await notifyUser(
        reseller.userId,
        "incentive_calculated",
        "Incentive calculated",
        `R${amount.toFixed(2)} in provisional incentives from order ${lines[0]!.orderNumber}. It is confirmed at month-end qualification.`,
        "/account/reseller?tab=incentives",
      );
    }
  }
  return inserted;
}

/**
 * Reverse incentives when order lines are cancelled, refunded, returned or
 * charged back. Unpaid accruals for a fully refunded line are marked
 * reversed; anything else gets a negative reversal row (a clawback when the
 * original was already paid). Returns rows that had already been paid.
 */
export async function reverseLineIncentives(orderItemId: number, quantity: number, lineFullyRefunded: boolean, reason: string) {
  const rows = await db
    .select()
    .from(commissionLedgerTable)
    .where(
      and(
        eq(commissionLedgerTable.orderItemId, orderItemId),
        eq(commissionLedgerTable.entryType, "accrual"),
        notInArray(commissionLedgerTable.status, ["void", "reversed"]),
      ),
    );
  const paidAffected: typeof rows = [];
  for (const row of rows) {
    if (row.status === "paid") paidAffected.push(row);
    if (lineFullyRefunded && (row.status === "pending" || row.status === "approved")) {
      const reversedSoFar = await db
        .select({ total: sql<string>`coalesce(sum(${commissionLedgerTable.amount}), 0)` })
        .from(commissionLedgerTable)
        .where(and(eq(commissionLedgerTable.reversalOfId, row.id), notInArray(commissionLedgerTable.status, ["void"])));
      await db
        .update(commissionLedgerTable)
        .set({ status: "reversed", reversedAt: new Date(), note: reason, updatedAt: new Date() })
        .where(eq(commissionLedgerTable.id, row.id));
      // Earlier partial reversals are now covered by reversing the whole accrual.
      if (Number(reversedSoFar[0]?.total ?? 0) !== 0) {
        await db
          .update(commissionLedgerTable)
          .set({ status: "void", note: `${reason} (superseded by full reversal)`, updatedAt: new Date() })
          .where(and(eq(commissionLedgerTable.reversalOfId, row.id), notInArray(commissionLedgerTable.status, ["paid"])));
      }
      continue;
    }
    const share = Math.min(quantity, row.quantity) / row.quantity;
    await db.insert(commissionLedgerTable).values({
      entryType: "reversal",
      orderId: row.orderId,
      orderItemId: row.orderItemId,
      orderNumber: row.orderNumber,
      period: row.period,
      productName: row.productName,
      quantity: -Math.min(quantity, row.quantity),
      sellerResellerId: row.sellerResellerId,
      beneficiaryResellerId: row.beneficiaryResellerId,
      kind: row.kind,
      beneficiaryRank: row.beneficiaryRank,
      rate: row.rate,
      baseValue: -round2(row.baseValue * share),
      amount: -round2(row.amount * share),
      qualificationStatus: row.qualificationStatus,
      status: "pending",
      reversalOfId: row.id,
      note: row.status === "paid" ? `Clawback: ${reason}` : reason,
    });
  }
  return paidAffected;
}

/**
 * Settle a period's ledger against the ranks actually qualified for in that
 * period: confirm rows that qualify, add rows that were missing, void
 * pending rows that do not qualify. Approved and paid rows are never touched.
 */
async function settleLedger(snapshot: NetworkSnapshot) {
  const { period, settings, resellers, stats } = snapshot;
  const lines = await paidOrderLines(and(eq(ordersTable.period, period), inArray(ordersTable.status, PAID_STATUSES)));
  const expected = expectedRows(lines, settings, {
    parentOf: (id) => resellers.get(id)?.sponsorId ?? null,
    rankOf: (id) => stats.get(id)?.qualifiedRank ?? "reseller",
    // Leadership incentives require an active beneficiary in good standing.
    eligible: (id) => resellers.get(id)?.standing === "good" && Boolean(stats.get(id)?.isActive),
  }, "qualified");
  const key = (r: { orderItemId: number; beneficiaryResellerId: number; kind: string }) => `${r.orderItemId}:${r.beneficiaryResellerId}:${r.kind}`;
  const existing = await db
    .select()
    .from(commissionLedgerTable)
    .where(and(eq(commissionLedgerTable.period, period), eq(commissionLedgerTable.entryType, "accrual")));
  // Prefer the live row when a voided row shares its key.
  const existingByKey = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    const current = existingByKey.get(key(row));
    if (!current || current.status === "void") existingByKey.set(key(row), row);
  }
  const expectedKeys = new Set<string>();
  let qualified = 0;
  let voided = 0;

  for (const row of expected) {
    const k = key(row as { orderItemId: number; beneficiaryResellerId: number; kind: string });
    expectedKeys.add(k);
    const current = existingByKey.get(k);
    if (!current) {
      await db.insert(commissionLedgerTable).values(row).onConflictDoNothing();
      qualified++;
    } else if (current.status === "pending" || current.status === "void") {
      await db
        .update(commissionLedgerTable)
        .set({
          status: "pending",
          qualificationStatus: "qualified",
          beneficiaryRank: row.beneficiaryRank,
          quantity: row.quantity,
          baseValue: row.baseValue,
          amount: incentiveAmount(row.baseValue!, current.rate),
          note: null,
          updatedAt: new Date(),
        })
        .where(eq(commissionLedgerTable.id, current.id));
      qualified++;
    }
  }
  for (const row of existing) {
    if (expectedKeys.has(key(row)) || row.status !== "pending") continue;
    await db
      .update(commissionLedgerTable)
      .set({
        status: "void",
        qualificationStatus: "not_qualified",
        note: `Not qualified for ${RANK_LABELS[row.kind] ?? row.kind} incentive in ${period}`,
        updatedAt: new Date(),
      })
      .where(eq(commissionLedgerTable.id, row.id));
    voided++;
  }
  // Pending partial reversals of voided accruals no longer apply.
  await db.execute(sql`
    update commission_ledger r set status = 'void', updated_at = now()
    from commission_ledger a
    where r.reversal_of_id = a.id and r.status = 'pending' and a.status in ('void', 'reversed') and r.period = ${period}
  `);
  return { qualified, voided };
}

/**
 * Month-end run: snapshot every reseller's qualification, apply rank
 * promotions/warnings/reversions and inactivity, then settle the ledger.
 * Safe to re-run; the latest run wins for the snapshot.
 */
export async function runQualification(period: string, actor: { id: number } | null) {
  const snapshot = await evaluatePeriod(period);
  const { settings, resellers, stats } = snapshot;
  let promotions = 0;
  let demotions = 0;
  let warnings = 0;

  const [previousRun] = await db.select().from(periodRunsTable).where(eq(periodRunsTable.period, period));
  const existingSnapshots = new Map(
    (await db.select().from(qualificationPeriodsTable).where(eq(qualificationPeriodsTable.period, period))).map((r) => [r.resellerId, r]),
  );

  const periodEnd = periodBounds(period).end;
  for (const reseller of resellers.values()) {
    // Not yet a reseller during this period: nothing to judge (no inactivity or rank warnings).
    if (reseller.approvedAt >= periodEnd) continue;
    const s = stats.get(reseller.id)!;
    // On a re-run, decide from the rank the reseller held before the first run.
    const prior = existingSnapshots.get(reseller.id);
    const base = prior
      ? {
          rank: prior.rankBefore,
          rankLocked: reseller.rankLocked,
          rankWarningMonths:
            rankValue(prior.rankAfter) < rankValue(prior.rankBefore)
              ? settings.rankGraceMonths
              : Math.max(0, reseller.rankWarningMonths - (prior.warning ? 1 : 0)),
        }
      : reseller;
    const decision = decideRank(base, s.qualifiedRank, settings.rankGraceMonths);
    const status = s.isActive ? "active" : "inactive";

    await db
      .update(resellersTable)
      .set({ rank: decision.rankAfter, rankWarningMonths: decision.warningMonths, status })
      .where(eq(resellersTable.id, reseller.id));

    const values = {
      resellerId: reseller.id,
      period,
      personalBottles: s.personalBottles,
      personalSales: s.personalSales,
      teamBottles: s.teamBottles,
      teamSales: s.teamSales,
      orgBottles: s.orgBottles,
      orgSales: s.orgSales,
      activeDirects: s.activeDirects,
      inactiveDirects: s.inactiveDirects,
      activeTeamLeaders: s.activeTeamLeaders,
      activeManagers: s.activeManagers,
      orgActiveResellers: s.orgActiveResellers,
      isActive: s.isActive,
      qualifiedRank: s.qualifiedRank,
      rankBefore: base.rank,
      rankAfter: decision.rankAfter,
      warning: decision.warning,
      computedAt: new Date(),
    };
    await db
      .insert(qualificationPeriodsTable)
      .values(values)
      .onConflictDoUpdate({ target: [qualificationPeriodsTable.resellerId, qualificationPeriodsTable.period], set: values });

    if (prior && prior.rankAfter === decision.rankAfter && prior.warning === decision.warning && prior.isActive === s.isActive) continue;
    const label = RANK_LABELS[decision.rankAfter] ?? decision.rankAfter;
    if (rankValue(decision.rankAfter) > rankValue(base.rank)) {
      promotions++;
      await notifyUser(reseller.userId, "rank_achieved", `Rank achieved: ${label}`, `Congratulations — you qualified as ${label} for ${period}.`, "/account/reseller");
      await audit("rank_promoted", "reseller", reseller.id, actor, { period, from: base.rank, to: decision.rankAfter });
    } else if (rankValue(decision.rankAfter) < rankValue(base.rank)) {
      demotions++;
      await notifyUser(reseller.userId, "rank_reverted", `Status update: ${label}`, `You did not maintain ${RANK_LABELS[base.rank]} requirements after your coaching month, so your status is now ${label}. You keep your reseller account and can re-qualify any month.`, "/account/reseller");
      await audit("rank_reverted", "reseller", reseller.id, actor, { period, from: base.rank, to: decision.rankAfter });
    } else if (decision.warning) {
      warnings++;
      await notifyUser(reseller.userId, "qualification_warning", "Qualification warning", `You did not meet the ${RANK_LABELS[reseller.rank]} requirements in ${period}. This is your coaching month — meet them next month to keep your rank.`, "/account/reseller");
    }
    if (!s.isActive && reseller.status === "active") {
      await notifyUser(reseller.userId, "inactivity_warning", "Inactivity notice", `No qualifying sales were recorded for ${period}, so your status is Inactive. Sell ${settings.reactivationBottles} bottles in a month to reactivate — no rejoining fee.`, "/account/reseller");
    }
  }

  const ledger = await settleLedger(snapshot);
  await db
    .insert(periodRunsTable)
    .values({ period, status: "closed", runAt: new Date(), runBy: actor?.id ?? null, resellerCount: resellers.size })
    .onConflictDoUpdate({ target: periodRunsTable.period, set: { status: "closed", runAt: new Date(), runBy: actor?.id ?? null, resellerCount: resellers.size } });
  await audit(previousRun?.status === "closed" ? "qualification_rerun" : actor ? "qualification_run" : "qualification_auto_run", "period", period, actor, { promotions, demotions, warnings, ...ledger });
  return { promotions, demotions, warnings, ledgerQualified: ledger.qualified, ledgerVoided: ledger.voided };
}

/**
 * Automatic month-end close: once a calendar month has ended, run its
 * qualification (ranks, warnings, reversions, incentive settlement) without
 * waiting for an administrator. Claiming the period with a "running" row
 * first means concurrent server instances can't double-run it. Admins can
 * still re-run any month from the console.
 */
export async function autoCloseQualification() {
  const period = previousPeriod(currentPeriod());
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(resellersTable);
  if (!count) return false;
  const claimed = await db
    .insert(periodRunsTable)
    .values({ period, status: "running", runAt: new Date() })
    .onConflictDoNothing()
    .returning({ period: periodRunsTable.period });
  if (!claimed.length) return false;
  await runQualification(period, null);
  return true;
}

/** Bring a reseller's live status up to date after a sale (reactivation). */
export async function refreshLiveStatus(resellerId: number, period: string) {
  const snapshot = await evaluatePeriod(period);
  const reseller = snapshot.resellers.get(resellerId);
  const s = snapshot.stats.get(resellerId);
  if (!reseller || !s) return;
  if (s.isActive && reseller.status !== "active") {
    await db.update(resellersTable).set({ status: "active" }).where(eq(resellersTable.id, resellerId));
    await audit("reseller_activated", "reseller", resellerId, null, { period, bottles: s.personalBottles });
  }
}

export async function resellerNames(ids: number[]) {
  if (!ids.length) return new Map<number, { name: string; code: string; firstName: string; mobile: string | null }>();
  const rows = await db
    .select({ id: resellersTable.id, code: resellersTable.resellerCode, firstName: usersTable.firstName, surname: usersTable.surname, mobile: usersTable.mobile })
    .from(resellersTable)
    .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId))
    .where(inArray(resellersTable.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { name: `${r.firstName} ${r.surname}`.trim() || r.code, code: r.code, firstName: r.firstName, mobile: r.mobile }]));
}
