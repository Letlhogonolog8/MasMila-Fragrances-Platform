import { db, auditLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The database or an open transaction — whatever a write should run on. */
export type Executor = Pick<Tx, "select" | "insert" | "update" | "execute">;

/**
 * Serialises writers of the commission ledger (refund reversals, month-end
 * settlement, approvals, payout allocation and settlement) for the rest of
 * the current transaction, so none of them acts on rows another is changing.
 */
export async function lockLedger(tx: Executor) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('masmila:commission_ledger'))`);
}

/** Audit row written inside a financial transaction: it commits or rolls back with the change. */
export async function auditIn(
  tx: Executor,
  action: string,
  entityType: string,
  entityId: string | number | null,
  actor: { id: number } | string | null | undefined,
  metadata?: Record<string, unknown>,
) {
  await tx.insert(auditLogsTable).values({
    action,
    entityType,
    entityId: entityId == null ? null : String(entityId),
    actorId: actor == null ? "system" : typeof actor === "string" ? actor : `user:${actor.id}`,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}
