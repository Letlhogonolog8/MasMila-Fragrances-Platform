import { db, commissionLedgerTable, payoutsTable, periodRunsTable, resellersTable, type Payout } from "@workspace/db";
import { and, count, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { badRequest, HttpError, notFound, round2 } from "./http";
import { isUniqueViolation } from "./codes";
import { isPeriod } from "./period";
import { notifyUser } from "./notify";
import { auditIn, lockLedger } from "./tx";

/**
 * Payouts: calculation is separate from execution, and nothing here moves
 * money — the administrator pays outside the platform and records each step.
 *
 *   pending ──approve──▶ approved ──processing──▶ processing ──paid──▶ paid
 *      └──────────────┴──────────────────┴──fail──▶ failed (rows released)
 *
 * Calculating allocates a reseller's approved, unallocated ledger rows (of
 * the payout period and earlier) to one new payout. A ledger row has a single
 * payout_id, allocation only takes rows whose payout_id is null, and the
 * database allows one non-failed payout per reseller and period — so the
 * same balance cannot be allocated or paid twice, whatever the concurrency.
 */
export type PayoutStatus = "pending" | "approved" | "processing" | "paid" | "failed";

const NEXT: Record<PayoutStatus, PayoutStatus[]> = {
  pending: ["approved", "failed"],
  approved: ["processing", "failed"],
  processing: ["paid", "failed"],
  paid: [],
  failed: [],
};

type Actor = { id: number };
type Skipped = { resellerId: number; reason: "payout_exists" | "nothing_payable" };

const payable = (resellerId: number, period: string) =>
  and(
    eq(commissionLedgerTable.beneficiaryResellerId, resellerId),
    eq(commissionLedgerTable.status, "approved"),
    isNull(commissionLedgerTable.payoutId),
    lte(commissionLedgerTable.period, period),
  );

/** Calculate pending payouts for `period` (optionally only some resellers). Safe to repeat or run concurrently. */
export async function calculatePayouts(input: { period: string; resellerIds?: number[] | null; reference?: string | null }, actor: Actor) {
  const { period } = input;
  if (!isPeriod(period)) throw badRequest("Choose a payout period as YYYY-MM.");
  const [run] = await db.select().from(periodRunsTable).where(eq(periodRunsTable.period, period));
  if (run?.status !== "closed") throw badRequest(`Run the month-end qualification for ${period} before calculating its payouts.`);

  const candidates = await db
    .selectDistinct({ resellerId: commissionLedgerTable.beneficiaryResellerId })
    .from(commissionLedgerTable)
    .where(
      and(
        eq(commissionLedgerTable.status, "approved"),
        isNull(commissionLedgerTable.payoutId),
        lte(commissionLedgerTable.period, period),
        input.resellerIds?.length ? inArray(commissionLedgerTable.beneficiaryResellerId, input.resellerIds) : undefined,
      ),
    );

  const created: Payout[] = [];
  const skipped: Skipped[] = [];
  for (const { resellerId } of candidates) {
    try {
      const outcome = await db.transaction(async (tx) => {
        await lockLedger(tx);
        const [active] = await tx
          .select({ id: payoutsTable.id })
          .from(payoutsTable)
          .where(and(eq(payoutsTable.resellerId, resellerId), eq(payoutsTable.period, period), ne(payoutsTable.status, "failed")));
        if (active) return { skipped: "payout_exists" as const };
        const rows = await tx
          .select({ id: commissionLedgerTable.id, amount: commissionLedgerTable.amount })
          .from(commissionLedgerTable)
          .where(payable(resellerId, period))
          .for("update");
        const amount = round2(rows.reduce((sum, r) => sum + r.amount, 0));
        // A net clawback (or nothing) carries forward to a later payout.
        if (amount <= 0) return { skipped: "nothing_payable" as const };
        const [reseller] = await tx.select({ code: resellersTable.resellerCode }).from(resellersTable).where(eq(resellersTable.id, resellerId));
        const [{ attempts }] = await tx
          .select({ attempts: count() })
          .from(payoutsTable)
          .where(and(eq(payoutsTable.resellerId, resellerId), eq(payoutsTable.period, period)));
        const [payout] = await tx
          .insert(payoutsTable)
          .values({
            payoutNumber: `PO-${period.replace("-", "")}-${reseller!.code.replace("MSM-", "")}${attempts ? `-${attempts + 1}` : ""}`,
            resellerId,
            period,
            amount,
            entryCount: rows.length,
            reference: input.reference?.trim() || null,
            status: "pending",
            createdBy: actor.id,
          })
          .returning();
        const allocated = await tx
          .update(commissionLedgerTable)
          .set({ payoutId: payout!.id, updatedAt: new Date() })
          .where(and(inArray(commissionLedgerTable.id, rows.map((r) => r.id)), isNull(commissionLedgerTable.payoutId), eq(commissionLedgerTable.status, "approved")))
          .returning({ id: commissionLedgerTable.id, amount: commissionLedgerTable.amount });
        if (allocated.length !== rows.length || round2(allocated.reduce((s, r) => s + r.amount, 0)) !== amount) {
          throw new Error("Payout allocation did not match the calculated rows"); // rolls the payout back
        }
        await auditIn(tx, "payout_calculated", "payout", payout!.payoutNumber, actor, { resellerId, period, amount, entries: rows.map((r) => r.id) });
        return { payout: payout! };
      });
      if (outcome.payout) created.push(outcome.payout);
      else skipped.push({ resellerId, reason: outcome.skipped! });
    } catch (err) {
      // Another request created this reseller's payout for the period first.
      if (isUniqueViolation(err)) skipped.push({ resellerId, reason: "payout_exists" });
      else throw err;
    }
  }
  return { created, skipped };
}

/**
 * Record the next step of a payout. Repeating the step it is already in is a
 * no-op (safe retries). `paid` marks its ledger rows paid after checking they
 * still add up to the payout; `failed` releases them for a later payout.
 */
export async function transitionPayout(
  payoutId: number,
  to: Exclude<PayoutStatus, "pending">,
  details: { reference?: string | null; failureReason?: string | null },
  actor: Actor,
) {
  const result = await db.transaction(async (tx) => {
    await lockLedger(tx);
    const [payout] = await tx.select().from(payoutsTable).where(eq(payoutsTable.id, payoutId)).for("update");
    if (!payout) throw notFound("Payout not found");
    if (payout.status === to) return { payout, changed: false };
    if (!NEXT[payout.status as PayoutStatus]?.includes(to)) {
      throw new HttpError(409, `A ${payout.status} payout cannot be marked ${to}.`);
    }
    const now = new Date();
    if (to === "paid") {
      const rows = await tx
        .update(commissionLedgerTable)
        .set({ status: "paid", paidAt: now, updatedAt: now })
        .where(and(eq(commissionLedgerTable.payoutId, payoutId), eq(commissionLedgerTable.status, "approved")))
        .returning({ amount: commissionLedgerTable.amount });
      if (rows.length !== payout.entryCount || round2(rows.reduce((s, r) => s + r.amount, 0)) !== payout.amount) {
        throw new HttpError(409, "This payout no longer matches its ledger entries. Mark it failed and recalculate.");
      }
    }
    if (to === "failed") {
      if (!details.failureReason?.trim()) throw badRequest("Give a reason for the failed payout.");
      await tx
        .update(commissionLedgerTable)
        .set({ payoutId: null, updatedAt: now })
        .where(and(eq(commissionLedgerTable.payoutId, payoutId), eq(commissionLedgerTable.status, "approved")));
    }
    const [updated] = await tx
      .update(payoutsTable)
      .set({
        status: to,
        updatedAt: now,
        ...(details.reference?.trim() ? { reference: details.reference.trim() } : {}),
        ...(to === "approved" ? { approvedBy: actor.id, approvedAt: now } : {}),
        ...(to === "processing" ? { processingBy: actor.id, processingAt: now } : {}),
        ...(to === "paid" ? { paidBy: actor.id, paidAt: now } : {}),
        ...(to === "failed" ? { failedBy: actor.id, failedAt: now, failureReason: details.failureReason!.trim() } : {}),
      })
      .where(and(eq(payoutsTable.id, payoutId), eq(payoutsTable.status, payout.status)))
      .returning();
    await auditIn(tx, `payout_${to}`, "payout", payout.payoutNumber, actor, {
      from: payout.status,
      to,
      amount: payout.amount,
      reference: details.reference ?? null,
      failureReason: details.failureReason ?? null,
    });
    return { payout: updated!, changed: true };
  });
  if (result.changed && to === "paid") {
    const [reseller] = await db.select().from(resellersTable).where(eq(resellersTable.id, result.payout.resellerId));
    if (reseller) {
      await notifyUser(reseller.userId, "incentive_paid", "Incentive paid", `R${result.payout.amount.toFixed(2)} has been paid to you (${result.payout.payoutNumber}).`, "/account/reseller?tab=incentives");
    }
  }
  return result.payout;
}
