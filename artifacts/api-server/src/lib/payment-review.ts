import { db, auditLogsTable, fraudFlagsTable, ordersTable, paymentEventsTable, usersTable, type PaymentEvent, type User } from "@workspace/db";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { PAID_STATUSES } from "./network";
import { badRequest, HttpError, iso, notFound, round2 } from "./http";
import { auditIn } from "./tx";
import { logger } from "./logger";

/**
 * Administrator review of payment notifications, in particular quarantined
 * (rejected) Shopify payments. Shows what is needed to reconcile a payment
 * with Shopify and the order — never customer contact details or secrets —
 * and records how each quarantined payment was dealt with. Recording a
 * resolution never changes the order, its stock or incentives, and never
 * moves money: refunds happen in Shopify, and an order is marked paid only
 * through Orders.
 */

export const RESOLUTION_ACTIONS = ["refunded_in_shopify", "confirmed_order_paid", "no_action_required", "other"] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

type ReviewFilter = { review?: "open" | "resolved" | "rejected" | "all"; reason?: string; q?: string };

async function views(rows: PaymentEvent[]) {
  if (!rows.length) return [];
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is number => id != null))];
  const resolverIds = [...new Set(rows.map((r) => r.resolvedBy).filter((id): id is number => id != null))];
  const orders = new Map(
    (orderIds.length
      ? await db
          .select({ id: ordersTable.id, orderNumber: ordersTable.orderNumber, status: ordersTable.status, paymentMethod: ordersTable.paymentMethod, total: ordersTable.total, paidAt: ordersTable.paidAt, shopifyOrderId: ordersTable.shopifyOrderId })
          .from(ordersTable)
          .where(inArray(ordersTable.id, orderIds))
      : []
    ).map((o) => [o.id, o]),
  );
  // Staff identity only (the administrator who resolved it).
  const resolvers = new Map(
    (resolverIds.length
      ? await db.select({ id: usersTable.id, firstName: usersTable.firstName, surname: usersTable.surname, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, resolverIds))
      : []
    ).map((u) => [u.id, `${u.firstName} ${u.surname}`.trim() || u.email]),
  );
  return rows.map((e) => {
    const order = e.orderId != null ? orders.get(e.orderId) : undefined;
    const expected = order ? order.total : null;
    return {
      id: e.id,
      provider: e.provider,
      topic: e.topic,
      externalOrderId: e.externalOrderId,
      externalReference: e.externalReference,
      deliveryId: e.deliveryId,
      amount: e.amount,
      currency: e.currency,
      financialStatus: e.financialStatus,
      outcome: e.outcome,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
      order: order ? { ...order, paidAt: iso(order.paidAt) } : null,
      expectedAmount: expected,
      difference: expected != null && e.amount != null ? round2(e.amount - expected) : null,
      review: e.outcome !== "rejected" ? ("not_required" as const) : e.resolvedAt ? ("resolved" as const) : ("open" as const),
      resolution: e.resolvedAt
        ? {
            action: e.resolutionAction!,
            reason: e.resolutionReason!,
            resolvedAt: e.resolvedAt.toISOString(),
            resolvedBy: resolvers.get(e.resolvedBy!) ?? `user:${e.resolvedBy}`,
            orderStatusAtResolution: e.resolutionOrderStatus,
          }
        : null,
    };
  });
}

export async function listPaymentEvents(filter: ReviewFilter) {
  const where: SQL[] = [];
  const review = filter.review ?? "open";
  if (review !== "all") where.push(eq(paymentEventsTable.outcome, "rejected"));
  if (review === "open") where.push(isNull(paymentEventsTable.resolvedAt));
  if (review === "resolved") where.push(isNotNull(paymentEventsTable.resolvedAt));
  if (filter.reason?.trim()) where.push(eq(paymentEventsTable.reason, filter.reason.trim()));
  const q = filter.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(
      or(
        ilike(paymentEventsTable.externalOrderId, like),
        ilike(paymentEventsTable.externalReference, like),
        sql`${paymentEventsTable.orderId} in (select id from orders where order_number ilike ${like})`,
      )!,
    );
  }
  const rows = await db.select().from(paymentEventsTable).where(where.length ? and(...where) : undefined).orderBy(desc(paymentEventsTable.createdAt), desc(paymentEventsTable.id)).limit(300);
  return views(rows);
}

export async function paymentEventDetail(id: number) {
  const [event] = await db.select().from(paymentEventsTable).where(eq(paymentEventsTable.id, id));
  if (!event) throw notFound("Payment event not found");
  const related = event.orderId != null
    ? await db.select().from(paymentEventsTable).where(and(eq(paymentEventsTable.orderId, event.orderId), sql`${paymentEventsTable.id} <> ${id}`)).orderBy(desc(paymentEventsTable.createdAt))
    : [];
  const history = await db
    .select()
    .from(auditLogsTable)
    .where(and(eq(auditLogsTable.entityType, "payment_event"), eq(auditLogsTable.entityId, String(id))))
    .orderBy(desc(auditLogsTable.createdAt));
  const [view] = await views([event]);
  return {
    event: view!,
    related: await views(related),
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
  };
}

/**
 * Records the administrator's resolution of a quarantined payment, once. The
 * event row is locked, so two administrators cannot both resolve it; the
 * audit row (actor, time, original status, action, reason, order status) is
 * written in the same transaction.
 */
export async function resolvePaymentEvent(id: number, input: { action: ResolutionAction; reason: string }, admin: User) {
  const reason = input.reason.trim();
  if (reason.length < 5) throw badRequest("Explain the resolution (at least 5 characters).");
  if (!RESOLUTION_ACTIONS.includes(input.action)) throw badRequest("Unknown resolution action.");
  await db.transaction(async (tx) => {
    const [event] = await tx.select().from(paymentEventsTable).where(eq(paymentEventsTable.id, id)).for("update");
    if (!event) throw notFound("Payment event not found");
    if (event.outcome !== "rejected") throw badRequest("Only quarantined (rejected) payments need a resolution.");
    if (event.resolvedAt) throw new HttpError(409, `This payment was already resolved (${event.resolutionAction}) on ${event.resolvedAt.toISOString()}.`);
    const [order] = event.orderId != null ? await tx.select().from(ordersTable).where(eq(ordersTable.id, event.orderId)) : [];
    if (input.action === "confirmed_order_paid" && (!order || !PAID_STATUSES.includes(order.status))) {
      throw badRequest("The order is not marked paid. Check the money arrived, mark the order paid from Orders, then record this resolution.");
    }
    const now = new Date();
    await tx
      .update(paymentEventsTable)
      .set({ resolvedAt: now, resolvedBy: admin.id, resolutionAction: input.action, resolutionReason: reason, resolutionOrderStatus: order?.status ?? null })
      .where(and(eq(paymentEventsTable.id, id), isNull(paymentEventsTable.resolvedAt)));
    // The alert raised for this payment is dealt with by the same decision.
    const closedFlags = await tx
      .update(fraudFlagsTable)
      .set({ status: "resolved", resolvedAt: now })
      .where(and(eq(fraudFlagsTable.paymentEventId, id), eq(fraudFlagsTable.status, "open")))
      .returning({ id: fraudFlagsTable.id });
    await auditIn(tx, "payment_event_resolved", "payment_event", id, admin, {
      action: input.action,
      reason,
      originalOutcome: event.outcome,
      originalReason: event.reason,
      review: { from: "open", to: "resolved" },
      shopifyOrderId: event.externalOrderId,
      amount: event.amount,
      currency: event.currency,
      orderNumber: order?.orderNumber ?? null,
      orderStatus: order?.status ?? null,
      fraudFlagsResolved: closedFlags.map((f) => f.id),
    });
  });
  logger.info({ event: "payment.review_resolved", paymentEventId: id, action: input.action, adminId: admin.id }, "Quarantined payment resolved");
  const [view] = await views((await db.select().from(paymentEventsTable).where(eq(paymentEventsTable.id, id))));
  return view!;
}
