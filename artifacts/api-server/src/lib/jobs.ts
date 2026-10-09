import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { db, jobRunsTable, ordersTable, periodRunsTable, resellersTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { runQualification } from "./network";
import { currentPeriod, previousPeriod } from "./period";
import { refundOrder } from "./orders";
import { getSettings } from "./settings";
import { HttpError } from "./http";
import { logger } from "./logger";
import { notifyAdmins, notifyEmail, notifyUser } from "./notify";
import { pruneRateLimits } from "./rate-limit";

/**
 * Scheduled work — month-end qualification and unpaid EFT reservation
 * expiry. Every trigger (Netlify scheduled function, the `jobs` CLI, the
 * long-running server's hourly timer, an administrator) calls the same
 * functions; the database decides who runs what, so triggers may overlap,
 * repeat or crash without double work.
 */

const envMs = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const jobConfig = {
  /** A month-end runner owns the month this long without renewing; then another may take over. */
  leaseMs: () => envMs("MONTH_END_LEASE_MS", 10 * 60_000),
  /** Automatic attempts per month before it waits for an administrator. */
  maxAutoAttempts: () => envMs("MONTH_END_MAX_ATTEMPTS", 5),
  /** Wait before automatic retry n+1: base × 2^(n-1), capped. */
  retryBaseMs: () => envMs("MONTH_END_RETRY_BASE_MS", 15 * 60_000),
  retryCapMs: () => envMs("MONTH_END_RETRY_CAP_MS", 6 * 3600_000),
};

export type JobTrigger = "schedule" | "admin" | "startup" | "cli" | "test";
const MONTH_END = "month_end_qualification";
const EXPIRY = "eft_reservation_expiry";

/** This runner no longer owns the month (its lease expired and another runner took over). */
export class LeaseLostError extends Error {}

const newOwner = () => `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 2000);

async function startRun(job: string, period: string | null, trigger: JobTrigger, owner: string, attempt: number, actorId: number | null) {
  const [run] = await db.insert(jobRunsTable).values({ job, period, trigger, owner, attempt, actorId, status: "running" }).returning();
  return run!;
}

async function finishRun(id: number, status: "succeeded" | "failed" | "abandoned", details: { error?: string; result?: unknown }) {
  await db
    .update(jobRunsTable)
    .set({ status, finishedAt: new Date(), error: details.error ?? null, result: details.result === undefined ? null : JSON.stringify(details.result) })
    .where(eq(jobRunsTable.id, id));
}

export type MonthEndOutcome =
  | { status: "succeeded"; period: string; attempt: number; runId: number; result: Awaited<ReturnType<typeof runQualification>> }
  | { status: "failed" | "abandoned"; period: string; attempt: number; runId: number; error: string }
  | { status: "skipped"; period: string; reason: "running" | "closed" | "retry_later" | "max_attempts" | "no_resellers" | "not_ended" };

/**
 * Claims `period` for this runner. Automatic runs claim a month that has not
 * closed: never run, failed (after its retry delay, below the attempt cap),
 * or "running" with an expired (or missing, legacy) lease. Manual runs may
 * also re-run a closed month, but never take a live lease.
 */
async function claimMonth(period: string, owner: string, mode: "auto" | "manual", actorId: number | null) {
  const leaseSecs = jobConfig.leaseMs() / 1000;
  const result = await db.execute<{ attempts: number }>(sql`
    insert into period_runs (period, status, run_at, run_by, lease_owner, lease_expires_at, attempts, started_at)
    values (${period}, 'running', now(), ${actorId}, ${owner}, now() + make_interval(secs => ${leaseSecs}), 1, now())
    on conflict (period) do update set
      status = 'running',
      run_by = excluded.run_by,
      lease_owner = excluded.lease_owner,
      lease_expires_at = excluded.lease_expires_at,
      attempts = case when period_runs.status = 'closed' then 1 else period_runs.attempts + 1 end,
      started_at = now()
    where (period_runs.status <> 'running' or period_runs.lease_expires_at is null or period_runs.lease_expires_at < now())
      and (${mode} = 'manual' or (
        period_runs.status <> 'closed'
        and period_runs.attempts < ${jobConfig.maxAutoAttempts()}
        and (period_runs.status <> 'failed' or period_runs.run_at <= now() - make_interval(secs => least(
          ${jobConfig.retryBaseMs() / 1000} * power(2, greatest(period_runs.attempts, 1) - 1),
          ${jobConfig.retryCapMs() / 1000})))))
    returning attempts`);
  return result.rows[0] ? { attempt: Number(result.rows[0].attempts) } : null;
}

/**
 * Why a month could not be claimed. A month whose last automatic attempt
 * crashed (lease expired, attempt cap reached) is marked failed here and
 * raised to administrators once, so it never sits silently in "running".
 */
async function whyNotClaimed(period: string): Promise<Extract<MonthEndOutcome, { status: "skipped" }>["reason"]> {
  const [row] = await db.select().from(periodRunsTable).where(eq(periodRunsTable.period, period));
  if (!row) return "running"; // lost a race for the very first claim
  if (row.status === "closed") return "closed";
  if (row.attempts < jobConfig.maxAutoAttempts()) return row.status === "running" ? "running" : "retry_later";
  if (row.status === "running") {
    const stalled = await db
      .update(periodRunsTable)
      .set({ status: "failed", lastError: `Attempt ${row.attempts} stopped responding (lease expired).`, runAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(periodRunsTable.period, period), eq(periodRunsTable.status, "running"), lt(periodRunsTable.leaseExpiresAt, sql`now()`)))
      .returning({ period: periodRunsTable.period });
    if (!stalled.length) return "running";
    await db
      .update(jobRunsTable)
      .set({ status: "abandoned", finishedAt: new Date(), error: "Lease expired (runner crashed or timed out)." })
      .where(and(eq(jobRunsTable.job, MONTH_END), eq(jobRunsTable.period, period), eq(jobRunsTable.status, "running")));
    logger.error({ event: "job.failed", job: MONTH_END, period, attempt: row.attempts, final: true }, "Month-end qualification stalled on its last automatic attempt");
    await notifyAdmins(
      "job_failed",
      `Month-end qualification stalled (${period})`,
      `Attempt ${row.attempts} stopped responding and automatic retries are used up. Run it from Incentives once the cause is fixed.`,
      "/admin?tab=incentives",
    );
  }
  return "max_attempts";
}

/** Extends this runner's lease; throws LeaseLostError if another runner has taken the month. */
async function renewLease(period: string, owner: string) {
  const renewed = await db
    .update(periodRunsTable)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${jobConfig.leaseMs() / 1000})` })
    .where(and(eq(periodRunsTable.period, period), eq(periodRunsTable.leaseOwner, owner), eq(periodRunsTable.status, "running")))
    .returning({ period: periodRunsTable.period });
  if (!renewed.length) throw new LeaseLostError(`Lost the lease on ${period}: another runner took over after it expired.`);
}

/**
 * Month-end qualification for one month, under a lease. Safe to call from any
 * number of processes at once: one claims the month, the rest return
 * "skipped". A runner that crashes or stalls loses its lease and a later call
 * resumes the month from its per-reseller snapshots; the stale runner notices
 * at its next checkpoint (or at commit) and stops without settling anything.
 * Failures are recorded, retried automatically with a growing delay, and
 * raised to administrators.
 */
export async function runMonthEnd(
  period: string,
  opts: { trigger: JobTrigger; actor?: { id: number } | null; mode?: "auto" | "manual"; hooks?: { afterReseller?: (n: number) => Promise<void> } },
): Promise<MonthEndOutcome> {
  const mode = opts.mode ?? (opts.trigger === "admin" ? "manual" : "auto");
  const actor = opts.actor ?? null;
  if (mode === "auto") {
    if (period >= currentPeriod()) return { status: "skipped", period, reason: "not_ended" };
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(resellersTable);
    if (!count) return { status: "skipped", period, reason: "no_resellers" };
  }
  const owner = newOwner();
  const claimed = await claimMonth(period, owner, mode, actor?.id ?? null);
  if (!claimed) return { status: "skipped", period, reason: await whyNotClaimed(period) };
  const { attempt } = claimed;
  const log = logger.child({ job: MONTH_END, period, attempt, owner, trigger: opts.trigger });

  // Earlier attempts still marked running lost their lease (crashed or timed out).
  await db
    .update(jobRunsTable)
    .set({ status: "abandoned", finishedAt: new Date(), error: `Lease expired; taken over by attempt ${attempt}.` })
    .where(and(eq(jobRunsTable.job, MONTH_END), eq(jobRunsTable.period, period), eq(jobRunsTable.status, "running"), ne(jobRunsTable.owner, owner)));
  const run = await startRun(MONTH_END, period, opts.trigger, owner, attempt, actor?.id ?? null);
  log.info({ event: "job.started", runId: run.id }, "Month-end qualification started");

  let lastRenewal = Date.now();
  try {
    const result = await runQualification(period, actor, {
      checkpoint: async (done) => {
        await opts.hooks?.afterReseller?.(done);
        if (Date.now() - lastRenewal >= jobConfig.leaseMs() / 3) {
          await renewLease(period, owner);
          lastRenewal = Date.now();
        }
      },
      close: async (tx, summary) => {
        const closed = await tx
          .update(periodRunsTable)
          .set({ status: "closed", runAt: new Date(), finishedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null, resellerCount: summary.resellerCount })
          .where(and(eq(periodRunsTable.period, period), eq(periodRunsTable.leaseOwner, owner), eq(periodRunsTable.status, "running")))
          .returning({ period: periodRunsTable.period });
        if (!closed.length) throw new LeaseLostError(`Lost the lease on ${period} before settling; the settlement was rolled back.`);
      },
    });
    await finishRun(run.id, "succeeded", { result });
    log.info({ event: "job.succeeded", runId: run.id, ...result }, "Month-end qualification completed");
    return { status: "succeeded", period, attempt, runId: run.id, result };
  } catch (err) {
    const error = message(err);
    if (err instanceof LeaseLostError) {
      await finishRun(run.id, "abandoned", { error });
      log.warn({ event: "job.lease_lost", runId: run.id, error }, "Month-end runner lost its lease and stopped");
      return { status: "abandoned", period, attempt, runId: run.id, error };
    }
    // Release the month as failed (only if still ours), so it is retried rather than stuck.
    await db
      .update(periodRunsTable)
      .set({ status: "failed", lastError: error, runAt: new Date(), leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(periodRunsTable.period, period), eq(periodRunsTable.leaseOwner, owner)));
    await finishRun(run.id, "failed", { error });
    const final = attempt >= jobConfig.maxAutoAttempts();
    log.error({ event: "job.failed", runId: run.id, err, final }, "Month-end qualification failed");
    await notifyAdmins(
      "job_failed",
      `Month-end qualification failed (${period})`,
      `Attempt ${attempt} failed: ${error}. ${final ? "It will not be retried automatically; run it from Incentives once the cause is fixed." : "It will be retried automatically."}`,
      "/admin?tab=incentives",
    );
    return { status: "failed", period, attempt, runId: run.id, error };
  }
}

export type ExpiryOutcome = {
  enabled: boolean;
  /** Reservation period per payment method (null = that method never expires). */
  hours: { eft: number | null; shopify: number | null };
  expired: number;
  alreadyDone: number;
  skipped: number;
  failed: number;
  runId?: number;
};

const EXPIRY_TEXT: Record<"eft" | "shopify", (n: string, h: number) => string> = {
  eft: (n, h) => `Order ${n} was cancelled because payment was not received within ${h} hours, and its stock was released. If you have already paid, please contact us with your proof of payment.`,
  shopify: (n, h) => `Order ${n} was cancelled because checkout was not completed within ${h} hours, and its stock was released. You are welcome to place a new order.`,
};

/**
 * Cancels unpaid orders older than their payment method's reservation period
 * (EFT, and unfinished Shopify checkouts) and releases their stock. Each
 * order is handled in its own transaction with the order row locked, and only
 * if — inside that lock — it is still an unpaid order of that method created
 * before the cutoff; a payment confirmed at the same moment wins. Each expiry
 * is keyed `expiry:<order id>`, so repeated or concurrent runs cancel an order
 * once. A Shopify payment arriving after expiry is quarantined (order_cancelled).
 */
export async function expireUnpaidOrders(opts: { trigger: JobTrigger; limit?: number }): Promise<ExpiryOutcome> {
  const settings = await getSettings();
  const hours = { eft: settings.eftReservationHours ?? null, shopify: settings.shopifyReservationHours ?? null };
  const outcome: ExpiryOutcome = { enabled: Boolean(hours.eft || hours.shopify), hours, expired: 0, alreadyDone: 0, skipped: 0, failed: 0 };
  if (!outcome.enabled) return outcome;

  const due: Array<{ id: number; orderNumber: string; userId: number | null; email: string; method: "eft" | "shopify"; hours: number; cutoff: Date }> = [];
  for (const method of ["eft", "shopify"] as const) {
    const h = hours[method];
    if (!h) continue;
    const cutoff = new Date(Date.now() - h * 3600_000);
    const rows = await db
      .select({ id: ordersTable.id, orderNumber: ordersTable.orderNumber, userId: ordersTable.userId, email: ordersTable.customerEmail })
      .from(ordersTable)
      .where(and(eq(ordersTable.status, "awaiting_payment"), eq(ordersTable.paymentMethod, method), lt(ordersTable.createdAt, cutoff)))
      .orderBy(asc(ordersTable.id))
      .limit(opts.limit ?? 200);
    due.push(...rows.map((r) => ({ ...r, method, hours: h, cutoff })));
  }
  if (!due.length) return outcome;

  const owner = newOwner();
  const run = await startRun(EXPIRY, null, opts.trigger, owner, 1, null);
  const log = logger.child({ job: EXPIRY, owner, trigger: opts.trigger, runId: run.id });
  for (const order of due) {
    try {
      const result = await refundOrder(
        order.id,
        {
          type: "cancel",
          reason: `Unpaid ${order.method === "eft" ? "EFT order" : "Shopify checkout"}: stock reservation expired after ${order.hours} hours`,
          source: "system",
          externalId: `expiry:${order.id}`,
          onlyIfUnpaid: { paymentMethod: order.method, createdBefore: order.cutoff },
        },
        "system:reservation-expiry",
      );
      if (result.replayed) {
        outcome.alreadyDone++;
        continue;
      }
      outcome.expired++;
      const text = EXPIRY_TEXT[order.method](order.orderNumber, order.hours);
      if (order.userId) await notifyUser(order.userId, "order_expired", "Order cancelled", text, `/account?order=${order.orderNumber}`);
      else await notifyEmail(order.email, "Order cancelled", text);
    } catch (err) {
      // Paid (or changed) in the meantime: it is no longer an unpaid reservation.
      if (err instanceof HttpError && err.status < 500) {
        outcome.skipped++;
        log.info({ event: "expiry.skipped", order: order.orderNumber, reason: err.message }, "Order no longer an unpaid reservation; not expired");
      } else {
        outcome.failed++;
        log.error({ event: "expiry.failed", order: order.orderNumber, err }, "Expiring an unpaid order failed; it will be retried on the next run");
      }
    }
  }
  await finishRun(run.id, outcome.failed ? "failed" : "succeeded", { result: outcome, ...(outcome.failed ? { error: `${outcome.failed} order(s) could not be expired` } : {}) });
  log.info({ event: "expiry.completed", ...outcome }, "Unpaid reservations processed");
  return { ...outcome, runId: run.id };
}

/**
 * Everything due now: last month's qualification, any earlier month left
 * failed or stuck (until its attempt cap), and reservation expiry. Never
 * throws — a scheduler only needs to call it.
 */
export async function runDueJobs(trigger: JobTrigger) {
  const monthEnd: MonthEndOutcome[] = [];
  let expiry: ExpiryOutcome | { error: string } | null = null;
  try {
    const unfinished = await db
      .select({ period: periodRunsTable.period })
      .from(periodRunsTable)
      .where(and(inArray(periodRunsTable.status, ["failed", "running", "open"]), lt(periodRunsTable.period, currentPeriod())))
      .orderBy(asc(periodRunsTable.period));
    const periods = [...new Set([...unfinished.map((r) => r.period), previousPeriod(currentPeriod())])].sort();
    for (const period of periods) monthEnd.push(await runMonthEnd(period, { trigger, mode: "auto" }));
  } catch (err) {
    logger.error({ event: "job.scheduler_failed", job: MONTH_END, err }, "Could not check month-end qualification");
  }
  try {
    expiry = await expireUnpaidOrders({ trigger });
  } catch (err) {
    logger.error({ event: "job.scheduler_failed", job: EXPIRY, err }, "Could not process unpaid reservations");
    expiry = { error: message(err) };
  }
  try {
    await pruneRateLimits();
  } catch (err) {
    logger.warn({ event: "job.scheduler_failed", job: "rate_limit_prune", err }, "Could not prune rate-limit counters");
  }
  return { monthEnd, expiry };
}

/** Recent job executions for the admin console. */
export async function recentJobRuns(limit = 50) {
  const runs = await db.select().from(jobRunsTable).orderBy(desc(jobRunsTable.startedAt), desc(jobRunsTable.id)).limit(limit);
  const months = await db.select().from(periodRunsTable).orderBy(desc(periodRunsTable.period)).limit(24);
  return { runs, months };
}
