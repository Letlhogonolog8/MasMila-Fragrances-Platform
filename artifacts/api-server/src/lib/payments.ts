import { db, ordersTable, paymentEventsTable, type Order } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterOrderPaid, settleOrderPaid, type PaidSettlement } from "./orders";
import { PAID_STATUSES } from "./network";
import { raiseFlag } from "./fraud";
import { logger } from "./logger";
import { shopifyPaymentPolicy } from "./runtime-env";
import type { Executor } from "./tx";

/** Every Mas'Mila price is in rand; Shopify must settle in the same currency. */
export const STORE_CURRENCY = "ZAR";

/**
 * The Shopify order webhook fields used here (REST Order shape, as in the
 * webhook reference for API version 2026-10). `order_id` and
 * `refund_line_items` come from refunds/create; the rest from orders/*.
 */
export type ShopifyOrderPayload = {
  id?: number | string;
  order_id?: number | string;
  name?: string;
  financial_status?: string;
  currency?: string;
  total_price?: string;
  total_price_set?: { shop_money?: { amount?: string; currency_code?: string } };
  total_outstanding?: string;
  test?: boolean;
  cancelled_at?: string | null;
  note_attributes?: Array<{ name: string; value: string }>;
  refund_line_items?: Array<{ quantity: number; line_item?: { variant_id?: number } }>;
};

export type PaymentRejection =
  | "invalid_payload"
  | "unknown_order"
  | "reference_mismatch"
  | "payment_method_mismatch"
  | "test_payment"
  | "live_payment_in_staging"
  | "shopify_order_cancelled"
  | "not_paid"
  | "partial_payment"
  | "currency_mismatch"
  | "underpayment"
  | "overpayment"
  | "duplicate_payment"
  | "order_cancelled"
  | "order_refunded";

export type PaymentAssessment =
  | { verdict: "apply" }
  | { verdict: "already_applied" }
  | { verdict: "reject"; reason: PaymentRejection; detail: string };

type AssessedOrder = Pick<Order, "orderNumber" | "status" | "paymentMethod" | "paymentReference" | "shopifyOrderId" | "total">;

const MONEY = /^\d+(\.\d{1,2})?$/;
/** Shopify sends money as decimal strings ("404.95"); anything else is not a valid amount. */
export const toCents = (value: unknown) =>
  typeof value === "string" && MONEY.test(value.trim()) ? Math.round(Number(value.trim()) * 100) : null;
const rand = (cents: number) => `R${(cents / 100).toFixed(2)}`;

export const noteAttribute = (payload: ShopifyOrderPayload, name: string) =>
  payload.note_attributes?.find((a) => a.name === name)?.value?.trim() || null;

/** What Shopify says was charged, in shop currency. */
export function paymentFacts(payload: ShopifyOrderPayload) {
  const shopMoney = payload.total_price_set?.shop_money;
  return {
    shopifyOrderId: payload.id == null || payload.id === "" ? null : String(payload.id),
    amountCents: toCents(shopMoney?.amount ?? payload.total_price),
    currency: shopMoney?.currency_code ?? payload.currency ?? null,
    financialStatus: payload.financial_status ?? null,
  };
}

/**
 * Decides whether an orders/paid notification may settle `order`. Only an
 * exact, complete payment in rand, for this order's Shopify checkout, by a
 * live (non-test) Shopify order is applied; everything else is rejected with
 * a reason and quarantined for review. Pure: no database access.
 */
export function assessShopifyPayment(
  order: AssessedOrder | undefined,
  payload: ShopifyOrderPayload,
  opts: { allowTest?: boolean; requireTest?: boolean } = {},
): PaymentAssessment {
  const reject = (reason: PaymentRejection, detail: string): PaymentAssessment => ({ verdict: "reject", reason, detail });
  const facts = paymentFacts(payload);
  if (!facts.shopifyOrderId) return reject("invalid_payload", "The payment notification has no Shopify order id.");
  const shopifyName = payload.name ?? facts.shopifyOrderId;
  if (!order) return reject("unknown_order", `Shopify order ${shopifyName} was paid but matches no Mas'Mila order.`);

  const reference = noteAttribute(payload, "masmila_order");
  if (reference && reference !== order.orderNumber) {
    return reject("reference_mismatch", `Shopify order ${shopifyName} names ${reference} but is linked to ${order.orderNumber}.`);
  }
  if (order.status !== "awaiting_payment") {
    if (order.shopifyOrderId === facts.shopifyOrderId) return { verdict: "already_applied" };
    if (order.status === "cancelled") {
      return reject("order_cancelled", `${order.orderNumber} is cancelled; the payment by Shopify order ${shopifyName} should be refunded.`);
    }
    if (order.status === "refunded" || order.status === "partially_refunded") {
      return reject("order_refunded", `${order.orderNumber} is ${order.status.replace("_", " ")}; Shopify order ${shopifyName} was not applied and should be refunded.`);
    }
    if (PAID_STATUSES.includes(order.status)) {
      const by = order.shopifyOrderId ? `Shopify order ${order.shopifyOrderId}` : (order.paymentReference ?? "manual confirmation");
      return reject("duplicate_payment", `${order.orderNumber} was already paid (${by}); Shopify order ${shopifyName} is a second payment and should be refunded.`);
    }
    return reject("order_cancelled", `${order.orderNumber} is ${order.status}; Shopify order ${shopifyName} was not applied.`);
  }
  if (order.shopifyOrderId && order.shopifyOrderId !== facts.shopifyOrderId) {
    return reject("reference_mismatch", `${order.orderNumber} is linked to Shopify order ${order.shopifyOrderId}, not ${shopifyName}.`);
  }
  if (order.paymentMethod !== "shopify") {
    return reject("payment_method_mismatch", `${order.orderNumber} is an ${order.paymentMethod.toUpperCase()} order; it did not create Shopify order ${shopifyName}.`);
  }
  if (payload.test === true && !opts.allowTest) {
    return reject("test_payment", `Shopify order ${shopifyName} is a test order; test payments never settle orders here.`);
  }
  if (payload.test !== true && opts.requireTest) {
    return reject("live_payment_in_staging", `Shopify order ${shopifyName} is a live (real-money) payment received by staging. Staging settles only test payments: refund it in Shopify and check which store this deployment is connected to.`);
  }
  if (payload.cancelled_at) return reject("shopify_order_cancelled", `Shopify order ${shopifyName} is cancelled.`);
  if (facts.financialStatus === "partially_paid") {
    return reject("partial_payment", `Shopify order ${shopifyName} is only partially paid.`);
  }
  if (facts.financialStatus !== "paid") {
    return reject("not_paid", `Shopify order ${shopifyName} has payment status "${facts.financialStatus ?? "missing"}", not "paid".`);
  }
  if (facts.currency !== STORE_CURRENCY) {
    return reject("currency_mismatch", `Shopify order ${shopifyName} was paid in ${facts.currency ?? "an unknown currency"}, not ${STORE_CURRENCY}.`);
  }
  if (facts.amountCents == null) return reject("invalid_payload", `Shopify order ${shopifyName} has no valid total.`);
  const outstanding = payload.total_outstanding == null ? 0 : toCents(payload.total_outstanding);
  if (outstanding == null) return reject("invalid_payload", `Shopify order ${shopifyName} has an invalid outstanding balance.`);
  if (outstanding > 0) {
    return reject("partial_payment", `Shopify order ${shopifyName} still has ${rand(outstanding)} outstanding.`);
  }
  const expected = Math.round(order.total * 100);
  if (facts.amountCents < expected) {
    return reject("underpayment", `Shopify order ${shopifyName} paid ${rand(facts.amountCents)}; ${order.orderNumber} is ${rand(expected)}.`);
  }
  if (facts.amountCents > expected) {
    return reject("overpayment", `Shopify order ${shopifyName} paid ${rand(facts.amountCents)}; ${order.orderNumber} is ${rand(expected)}. Refund the difference or confirm manually.`);
  }
  return { verdict: "apply" };
}

/**
 * The Mas'Mila order a Shopify webhook refers to: by the masmila_order cart
 * attribute (orders/*), else by the linked Shopify order id (refunds/create
 * carries only `order_id`). With `lock`, the row is locked for the caller's
 * transaction.
 */
export async function findShopifyOrder(executor: Executor, payload: ShopifyOrderPayload, opts: { lock?: boolean } = {}) {
  const byNumber = noteAttribute(payload, "masmila_order");
  const shopifyId = String(payload.order_id ?? payload.id ?? "");
  const where = byNumber ? eq(ordersTable.orderNumber, byNumber) : shopifyId ? eq(ordersTable.shopifyOrderId, shopifyId) : null;
  if (!where) return undefined;
  const query = executor.select().from(ordersTable).where(where);
  const [order] = opts.lock ? await query.for("update") : await query;
  if (order || !byNumber || !shopifyId) return order;
  const fallback = executor.select().from(ordersTable).where(eq(ordersTable.shopifyOrderId, shopifyId));
  return (opts.lock ? await fallback.for("update") : await fallback)[0];
}

export type PaymentOutcome = {
  outcome: "applied" | "already_applied" | "duplicate" | "rejected";
  reason?: PaymentRejection;
  orderNumber?: string;
  paymentEventId?: number;
};

/**
 * Applies a signed orders/paid notification exactly once. One transaction:
 * the payment event is recorded (unique per Shopify order, so a retried or
 * concurrent delivery finds it and changes nothing), the order row is locked,
 * the payment is checked against the order, and only an exact match settles
 * the order (stock, incentives, audit). A rejected payment is stored with its
 * reason and raised to administrators; the order is left untouched. If
 * anything throws, the whole transaction — including the event record — rolls
 * back, so Shopify's retry processes it again from scratch.
 */
export async function applyShopifyPayment(
  payload: ShopifyOrderPayload,
  meta: { topic: string; deliveryId?: string | null; shopDomain?: string | null; apiVersion?: string | null },
): Promise<PaymentOutcome> {
  const facts = paymentFacts(payload);
  const log = logger.child({ provider: "shopify", topic: meta.topic, deliveryId: meta.deliveryId ?? null, shopifyOrderId: facts.shopifyOrderId });
  const eventKey = facts.shopifyOrderId ? `orders/paid:${facts.shopifyOrderId}` : `delivery:${meta.deliveryId ?? "unknown"}`;

  const result = await db.transaction(async (tx) => {
    const [event] = await tx
      .insert(paymentEventsTable)
      .values({
        provider: "shopify",
        topic: meta.topic,
        eventKey,
        deliveryId: meta.deliveryId ?? null,
        externalOrderId: facts.shopifyOrderId,
        externalReference: payload.name ?? null,
        amount: facts.amountCents == null ? null : facts.amountCents / 100,
        currency: facts.currency,
        financialStatus: facts.financialStatus,
        shopDomain: meta.shopDomain ?? null,
        apiVersion: meta.apiVersion ?? null,
        testPayment: typeof payload.test === "boolean" ? payload.test : null,
        outcome: "rejected",
      })
      .onConflictDoNothing()
      .returning({ id: paymentEventsTable.id });
    if (!event) return { duplicate: true as const };

    const order = await findShopifyOrder(tx, payload, { lock: true });
    const assessment = assessShopifyPayment(order, payload, shopifyPaymentPolicy());
    let settled: PaidSettlement | null = null;
    if (assessment.verdict === "apply") {
      settled = await settleOrderPaid(tx, order!, "shopify", {
        shopifyOrderId: facts.shopifyOrderId!,
        paymentReference: payload.name ?? facts.shopifyOrderId!,
        paymentEventId: event.id,
      });
    }
    await tx
      .update(paymentEventsTable)
      .set({
        orderId: order?.id ?? null,
        outcome: assessment.verdict === "apply" ? "applied" : assessment.verdict === "reject" ? "rejected" : "already_applied",
        reason: assessment.verdict === "reject" ? assessment.reason : null,
      })
      .where(eq(paymentEventsTable.id, event.id));
    return { duplicate: false as const, eventId: event.id, order, assessment, settled };
  });

  if (result.duplicate) {
    log.info({ event: "payment.duplicate_delivery", eventKey }, "Shopify payment already recorded; delivery ignored");
    return { outcome: "duplicate" };
  }
  const { eventId, order, assessment, settled } = result;
  const fields = { paymentEventId: eventId, order: order?.orderNumber ?? null, amount: facts.amountCents == null ? null : facts.amountCents / 100, currency: facts.currency };
  if (assessment.verdict === "reject") {
    log.warn({ event: "payment.rejected", reason: assessment.reason, expected: order?.total ?? null, financialStatus: facts.financialStatus, ...fields }, "Shopify payment rejected and quarantined");
    await raiseFlag({ type: "payment_rejected", severity: "high", detail: `Payment not applied (${assessment.reason.replaceAll("_", " ")}): ${assessment.detail}`, orderId: order?.id ?? null, paymentEventId: eventId });
    return { outcome: "rejected", reason: assessment.reason, orderNumber: order?.orderNumber, paymentEventId: eventId };
  }
  if (assessment.verdict === "already_applied") {
    log.info({ event: "payment.already_applied", ...fields }, "Shopify payment was already applied to this order");
    return { outcome: "already_applied", orderNumber: order?.orderNumber, paymentEventId: eventId };
  }
  log.info({ event: "payment.applied", ...fields }, "Shopify payment verified and applied");
  await afterOrderPaid(settled!);
  return { outcome: "applied", orderNumber: order?.orderNumber, paymentEventId: eventId };
}

/**
 * Whether a Shopify cancellation or refund may change `order`. It must come
 * from the Shopify order linked to it (the link is only set by a verified
 * payment). An unlinked order only accepts the cancellation of its still-unpaid
 * Shopify checkout, which releases the reserved stock — never a refund, and
 * never anything on an order paid by EFT or confirmed by an administrator.
 * Returns the reason to refuse, or null.
 */
export function shopifyRefundRejection(order: AssessedOrder, payload: ShopifyOrderPayload, topic: string): string | null {
  const shopifyOrderId = String(payload.order_id ?? payload.id ?? "");
  if (order.shopifyOrderId) return order.shopifyOrderId === shopifyOrderId ? null : "reference_mismatch";
  if (order.paymentMethod !== "shopify") return "payment_method_mismatch";
  return topic === "orders/cancelled" && order.status === "awaiting_payment" ? null : "unverified_payment";
}
