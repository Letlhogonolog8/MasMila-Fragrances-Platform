import {
  db,
  commissionLedgerTable,
  orderItemsTable,
  ordersTable,
  periodRunsTable,
  qualificationPeriodsTable,
  refundItemsTable,
  refundsTable,
  resellersTable,
  usersTable,
  type Reseller,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
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
import { auditIn, lockLedger, type Executor, type Tx } from "./tx";

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
type LedgerRow = typeof commissionLedgerTable.$inferSelect;

async function paidOrderLines(where: ReturnType<typeof and>, ex: Executor = db) {
  return ex
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

/**
 * Expected accrual rows for order lines given a rank lookup. Accruals are
 * always on the line's full quantity: refunds are represented by their own
 * reversal rows, never by shrinking the accrual.
 */
function expectedRows(
  lines: Line[],
  settings: Settings,
  ctx: { parentOf: (id: number) => number | null; rankOf: (id: number) => string; eligible: (id: number) => boolean },
  qualificationStatus: "provisional" | "qualified",
): LedgerRowInput[] {
  const rows: LedgerRowInput[] = [];
  for (const line of lines) {
    if (!line.period) continue;
    const base = round2(line.quantity * line.unitWholesale);
    const common = {
      orderId: line.orderId,
      orderItemId: line.itemId,
      orderNumber: line.orderNumber,
      period: line.period,
      productName: line.productName,
      quantity: line.quantity,
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
      const retailBase = round2(line.quantity * line.unitPrice);
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
 * One negative reversal row for `quantity` refunded units of an accrual's
 * order line. The amount is the accrual's proportional share, capped at what
 * is still unreversed; the refund that completes the line reverses exactly
 * the remainder, so reversals can never exceed the original incentive and a
 * fully refunded line nets to zero despite rounding. A reversal is payable
 * whenever its accrual is: pending with a pending accrual, approved once the
 * accrual is approved or paid (a clawback deducted from the next payout).
 */
async function insertReversal(
  tx: Executor,
  accrual: LedgerRow,
  r: { quantity: number; refundedBefore: number; lineQuantity: number; refundId: number | null; reason: string },
) {
  const [{ total }] = await tx
    .select({ total: sql<string>`coalesce(sum(${commissionLedgerTable.amount}), 0)` })
    .from(commissionLedgerTable)
    .where(and(eq(commissionLedgerTable.reversalOfId, accrual.id), ne(commissionLedgerTable.status, "void")));
  const remaining = round2(accrual.amount + Number(total));
  if (remaining <= 0 || r.quantity <= 0) return null;
  const completesLine = r.refundedBefore + r.quantity >= r.lineQuantity;
  const amount = completesLine ? remaining : Math.min(remaining, round2((accrual.amount * r.quantity) / r.lineQuantity));
  if (amount <= 0) return null; // a sub-cent share: the line's final refund reverses it with the remainder
  const payable = accrual.status === "approved" || accrual.status === "paid";
  const [row] = await tx
    .insert(commissionLedgerTable)
    .values({
      entryType: "reversal",
      orderId: accrual.orderId,
      orderItemId: accrual.orderItemId,
      orderNumber: accrual.orderNumber,
      period: accrual.period,
      productName: accrual.productName,
      quantity: -r.quantity,
      sellerResellerId: accrual.sellerResellerId,
      beneficiaryResellerId: accrual.beneficiaryResellerId,
      kind: accrual.kind,
      beneficiaryRank: accrual.beneficiaryRank,
      rate: accrual.rate,
      baseValue: -round2((accrual.baseValue * r.quantity) / r.lineQuantity),
      amount: -amount,
      qualificationStatus: accrual.qualificationStatus,
      status: payable ? "approved" : "pending",
      approvedAt: payable ? new Date() : null,
      reversalOfId: accrual.id,
      refundId: r.refundId,
      note: accrual.status === "paid" ? `Clawback: ${r.reason}` : r.reason,
    })
    // Unique (refund, accrual): the same refund can never reverse an accrual twice.
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * Reversals for refunds that were recorded before this accrual existed (for
 * example an attribution changed after a partial refund), replayed in order
 * so the accrual nets exactly as if it had existed all along.
 */
async function reverseEarlierRefunds(tx: Executor, accrual: LedgerRow, line: Pick<Line, "itemId" | "quantity" | "refundedQuantity">) {
  if (line.refundedQuantity <= 0) return;
  const items = await tx
    .select({ refundId: refundItemsTable.refundId, quantity: refundItemsTable.quantity, type: refundsTable.type, reason: refundsTable.reason })
    .from(refundItemsTable)
    .innerJoin(refundsTable, eq(refundsTable.id, refundItemsTable.refundId))
    .where(and(eq(refundItemsTable.orderItemId, line.itemId), eq(refundsTable.orderWasPaid, true)))
    .orderBy(refundItemsTable.id);
  let before = 0;
  // Refunds made before refunds were recorded individually (no refund row).
  const untracked = line.refundedQuantity - items.reduce((sum, i) => sum + i.quantity, 0);
  if (untracked > 0) {
    await insertReversal(tx, accrual, { quantity: untracked, refundedBefore: 0, lineQuantity: line.quantity, refundId: null, reason: "Refunded before this incentive was recorded" });
    before = untracked;
  }
  for (const item of items) {
    await insertReversal(tx, accrual, { quantity: item.quantity, refundedBefore: before, lineQuantity: line.quantity, refundId: item.refundId, reason: `${item.type}: ${item.reason}` });
    before += item.quantity;
  }
}

/**
 * Provisional incentives the moment an order is paid, using current ranks,
 * so dashboards update in real time. The month-end run confirms or voids
 * them. Runs inside the caller's transaction (payment or attribution change)
 * so a sale is never left paid without its incentives. Returns inserted rows
 * for the caller to announce after commit (see notifyAccruals).
 */
export async function accrueOrderIncentives(orderId: number, tx: Executor) {
  const settings = await getSettings(tx);
  const lines = await paidOrderLines(and(eq(ordersTable.id, orderId), inArray(ordersTable.status, PAID_STATUSES)), tx);
  if (!lines.length) return [];
  const resellers = new Map((await tx.select().from(resellersTable)).map((r) => [r.id, r]));
  const rows = expectedRows(lines, settings, {
    parentOf: (id) => resellers.get(id)?.sponsorId ?? null,
    rankOf: (id) => resellers.get(id)?.rank ?? "reseller",
    eligible: (id) => eligibleStanding(resellers.get(id)?.standing),
  }, "provisional");
  if (!rows.length) return [];
  // Unique index (order line, beneficiary, kind) makes this idempotent: no duplicate claims.
  const inserted = await tx.insert(commissionLedgerTable).values(rows).onConflictDoNothing().returning();
  for (const row of inserted) {
    const line = lines.find((l) => l.itemId === row.orderItemId);
    if (line) await reverseEarlierRefunds(tx, row, line);
  }
  return inserted;
}

/** In-app/email notice of newly accrued incentives (after the accruing transaction commits). */
export async function notifyAccruals(inserted: LedgerRow[]) {
  if (!inserted.length) return;
  const byBeneficiary = new Map<number, number>();
  for (const row of inserted) byBeneficiary.set(row.beneficiaryResellerId, (byBeneficiary.get(row.beneficiaryResellerId) ?? 0) + row.amount);
  const resellers = await db.select().from(resellersTable).where(inArray(resellersTable.id, [...byBeneficiary.keys()]));
  for (const reseller of resellers) {
    await notifyUser(
      reseller.userId,
      "incentive_calculated",
      "Incentive calculated",
      `R${byBeneficiary.get(reseller.id)!.toFixed(2)} in provisional incentives from order ${inserted[0]!.orderNumber}. It is confirmed at month-end qualification.`,
      "/account/reseller?tab=incentives",
    );
  }
}

/**
 * Reverse the incentives on one order line for one refund. Called inside the
 * refund's transaction. Returns the accruals that had already been paid out
 * (their reversals are clawbacks) and the reversal rows written.
 */
export async function reverseLineIncentives(
  tx: Executor,
  r: { orderItemId: number; lineQuantity: number; refundedBefore: number; quantity: number; refundId: number; reason: string },
) {
  const accruals = await tx
    .select()
    .from(commissionLedgerTable)
    .where(
      and(
        eq(commissionLedgerTable.orderItemId, r.orderItemId),
        eq(commissionLedgerTable.entryType, "accrual"),
        inArray(commissionLedgerTable.status, ["pending", "approved", "paid"]),
      ),
    );
  const paidAffected: LedgerRow[] = [];
  const reversals: LedgerRow[] = [];
  for (const accrual of accruals) {
    const row = await insertReversal(tx, accrual, r);
    if (!row) continue;
    reversals.push(row);
    if (accrual.status === "paid") paidAffected.push(accrual);
  }
  return { paidAffected, reversals };
}

/**
 * Settle a period's ledger against the ranks actually qualified for in that
 * period: confirm rows that qualify, add rows that were missing, void
 * pending rows that do not qualify. Approved and paid rows are never touched,
 * and no accrual amount is ever changed. Runs as one transaction.
 */
async function settleLedger(snapshot: NetworkSnapshot, close: (tx: Tx) => Promise<void>) {
  const { period, settings, resellers, stats } = snapshot;
  return db.transaction(async (tx) => {
    await lockLedger(tx);
    const lines = await paidOrderLines(and(eq(ordersTable.period, period), inArray(ordersTable.status, PAID_STATUSES)), tx);
    const lineById = new Map(lines.map((l) => [l.itemId, l]));
    const expected = expectedRows(lines, settings, {
      parentOf: (id) => resellers.get(id)?.sponsorId ?? null,
      rankOf: (id) => stats.get(id)?.qualifiedRank ?? "reseller",
      // Leadership incentives require an active beneficiary in good standing.
      eligible: (id) => resellers.get(id)?.standing === "good" && Boolean(stats.get(id)?.isActive),
    }, "qualified");
    const key = (r: { orderItemId: number; beneficiaryResellerId: number; kind: string }) => `${r.orderItemId}:${r.beneficiaryResellerId}:${r.kind}`;
    const existing = await tx
      .select()
      .from(commissionLedgerTable)
      .where(and(eq(commissionLedgerTable.period, period), eq(commissionLedgerTable.entryType, "accrual")));
    // Prefer the live row when a voided row shares its key.
    const existingByKey = new Map<string, LedgerRow>();
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
        const [inserted] = await tx.insert(commissionLedgerTable).values(row).onConflictDoNothing().returning();
        if (inserted) await reverseEarlierRefunds(tx, inserted, lineById.get(inserted.orderItemId)!);
        qualified++;
      } else if (current.status === "pending" || current.status === "void") {
        await tx
          .update(commissionLedgerTable)
          .set({ status: "pending", qualificationStatus: "qualified", beneficiaryRank: row.beneficiaryRank, note: null, updatedAt: new Date() })
          .where(eq(commissionLedgerTable.id, current.id));
        if (current.status === "void") {
          // A revived accrual brings back the reversals of its real refunds.
          await tx
            .update(commissionLedgerTable)
            .set({ status: "pending", updatedAt: new Date() })
            .where(and(eq(commissionLedgerTable.reversalOfId, current.id), eq(commissionLedgerTable.status, "void"), isNotNull(commissionLedgerTable.refundId)));
        }
        qualified++;
      }
    }
    for (const row of existing) {
      if (expectedKeys.has(key(row)) || row.status !== "pending") continue;
      await tx
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
    // Pending reversals of voided accruals no longer apply.
    await tx.execute(sql`
      update commission_ledger r set status = 'void', updated_at = now()
      from commission_ledger a
      where r.reversal_of_id = a.id and r.status = 'pending' and a.status in ('void', 'reversed') and r.period = ${period}
    `);
    // Marks the month closed in the same transaction: settled and closed together, or neither.
    await close(tx);
    return { qualified, voided };
  });
}

/**
 * Hooks for a leased month-end run (lib/jobs.ts). `checkpoint` runs after
 * each reseller is written and throws to abort (lease lost). `close` runs
 * inside the settlement transaction and must throw unless this runner still
 * owns the month, so a superseded runner can never settle it.
 */
export type QualificationRunControl = {
  checkpoint?: (resellersDone: number) => Promise<void>;
  close?: (tx: Tx, summary: { resellerCount: number }) => Promise<void>;
};

/**
 * Month-end run: snapshot every reseller's qualification, apply rank
 * promotions/warnings/reversions and inactivity, then settle the ledger.
 * Safe to re-run; the latest run wins for the snapshot.
 */
export async function runQualification(period: string, actor: { id: number } | null, control: QualificationRunControl = {}) {
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
  let done = 0;
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
    const unchanged = prior && prior.rankAfter === decision.rankAfter && prior.warning === decision.warning && prior.isActive === s.isActive;
    const promoted = rankValue(decision.rankAfter) > rankValue(base.rank);
    const reverted = rankValue(decision.rankAfter) < rankValue(base.rank);
    // One transaction per reseller: the rank change, its snapshot and audit row are
    // written together. A run interrupted between resellers is resumed by re-running:
    // a reseller with a snapshot is re-decided from its snapshot's rankBefore, one
    // without from its untouched current rank, so nothing is applied twice.
    await db.transaction(async (tx) => {
      await tx
        .update(resellersTable)
        .set({ rank: decision.rankAfter, rankWarningMonths: decision.warningMonths, status })
        .where(eq(resellersTable.id, reseller.id));
      await tx
        .insert(qualificationPeriodsTable)
        .values(values)
        .onConflictDoUpdate({ target: [qualificationPeriodsTable.resellerId, qualificationPeriodsTable.period], set: values });
      if (!unchanged && (promoted || reverted)) {
        await auditIn(tx, promoted ? "rank_promoted" : "rank_reverted", "reseller", reseller.id, actor, { period, from: base.rank, to: decision.rankAfter });
      }
    });
    await control.checkpoint?.(++done);

    if (unchanged) continue;
    const label = RANK_LABELS[decision.rankAfter] ?? decision.rankAfter;
    if (promoted) {
      promotions++;
      await notifyUser(reseller.userId, "rank_achieved", `Rank achieved: ${label}`, `Congratulations — you qualified as ${label} for ${period}.`, "/account/reseller");
    } else if (reverted) {
      demotions++;
      await notifyUser(reseller.userId, "rank_reverted", `Status update: ${label}`, `You did not maintain ${RANK_LABELS[base.rank]} requirements after your coaching month, so your status is now ${label}. You keep your reseller account and can re-qualify any month.`, "/account/reseller");
    } else if (decision.warning) {
      warnings++;
      await notifyUser(reseller.userId, "qualification_warning", "Qualification warning", `You did not meet the ${RANK_LABELS[reseller.rank]} requirements in ${period}. This is your coaching month — meet them next month to keep your rank.`, "/account/reseller");
    }
    if (!s.isActive && reseller.status === "active") {
      await notifyUser(reseller.userId, "inactivity_warning", "Inactivity notice", `No qualifying sales were recorded for ${period}, so your status is Inactive. Sell ${settings.reactivationBottles} bottles in a month to reactivate — no rejoining fee.`, "/account/reseller");
    }
  }

  const ledger = await settleLedger(snapshot, async (tx) => {
    if (control.close) return control.close(tx, { resellerCount: resellers.size });
    const closed = { status: "closed", runAt: new Date(), runBy: actor?.id ?? null, resellerCount: resellers.size, finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null };
    await tx.insert(periodRunsTable).values({ period, ...closed }).onConflictDoUpdate({ target: periodRunsTable.period, set: closed });
  });
  await audit(previousRun?.status === "closed" || previousRun?.finishedAt ? "qualification_rerun" : actor ? "qualification_run" : "qualification_auto_run", "period", period, actor, { promotions, demotions, warnings, ...ledger });
  return { promotions, demotions, warnings, ledgerQualified: ledger.qualified, ledgerVoided: ledger.voided };
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
