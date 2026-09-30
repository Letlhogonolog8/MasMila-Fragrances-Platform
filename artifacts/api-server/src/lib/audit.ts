import { db, auditLogsTable } from "@workspace/db";
import { logger } from "./logger";

type Actor = { id: number } | string | null | undefined;

/** Append-only audit trail for every state change that matters. */
export async function audit(
  action: string,
  entityType: string,
  entityId: string | number | null,
  actor: Actor,
  metadata?: Record<string, unknown>,
) {
  try {
    await db.insert(auditLogsTable).values({
      action,
      entityType,
      entityId: entityId == null ? null : String(entityId),
      actorId: actor == null ? "system" : typeof actor === "string" ? actor : `user:${actor.id}`,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  } catch (err) {
    logger.error({ err, action }, "Failed to write audit log");
  }
}
