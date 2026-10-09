import express, { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, orderItemsTable, productsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { refundOrder } from "../lib/orders";
import { applyShopifyPayment, findShopifyOrder, shopifyRefundRejection, type ShopifyOrderPayload } from "../lib/payments";
import { raiseFlag } from "../lib/fraud";
import { logger } from "../lib/logger";
import { HttpError } from "../lib/http";
import { configuredShopDomain } from "../lib/runtime-env";

/**
 * Shopify webhooks (orders/paid, orders/cancelled, refunds/create). Mounted
 * before the JSON body parser because the HMAC is computed over the raw body.
 * Configure in Shopify admin → Settings → Notifications → Webhooks with
 * URL https://<host>/api/webhooks/shopify, and set SHOPIFY_WEBHOOK_SECRET to
 * the signing secret shown there (for an app subscription: the app's client
 * secret).
 *
 * Responses: 401 for a bad signature (nothing is read or stored); 200 for
 * every signed event that was handled — applied, already applied, duplicate
 * or rejected/quarantined — so Shopify does not retry a decision; 500 only
 * when processing failed part-way (everything rolled back), so Shopify's
 * retry processes the event again.
 */
const router: IRouter = Router();

export function verifyShopifySignature(raw: Buffer, signature: string | undefined, secret = process.env.SHOPIFY_WEBHOOK_SECRET) {
  if (!secret || !signature) return false;
  const digest = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature, "base64");
  return given.length === digest.length && timingSafeEqual(given, digest);
}

router.post("/webhooks/shopify", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const raw = req.body as Buffer;
  const topic = req.get("X-Shopify-Topic") ?? "";
  const deliveryId = req.get("X-Shopify-Webhook-Id") ?? null;
  const shopDomain = req.get("X-Shopify-Shop-Domain")?.trim().toLowerCase() ?? null;
  const apiVersion = req.get("X-Shopify-API-Version") ?? null;
  const log = logger.child({ provider: "shopify", topic, deliveryId, shopDomain });
  if (!process.env.SHOPIFY_WEBHOOK_SECRET) log.error({ event: "webhook.secret_missing" }, "SHOPIFY_WEBHOOK_SECRET is not set; rejecting Shopify webhook");
  if (!Buffer.isBuffer(raw) || !verifyShopifySignature(raw, req.get("X-Shopify-Hmac-Sha256"))) {
    log.warn({ event: "webhook.signature_invalid" }, "Rejected Shopify webhook with an invalid signature");
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  // Signed by our secret AND sent by the store this deployment is configured
  // for: a delivery from any other store (e.g. the live store calling the
  // staging URL) is refused, even if its signature were valid.
  const expectedShop = configuredShopDomain();
  if (expectedShop && shopDomain !== expectedShop) {
    log.warn({ event: "webhook.shop_mismatch", expectedShop }, "Rejected Shopify webhook from a different store");
    res.status(401).json({ error: "Webhook is not from this deployment's store" });
    return;
  }
  let payload: ShopifyOrderPayload;
  try {
    payload = JSON.parse(raw.toString("utf8")) as ShopifyOrderPayload;
  } catch {
    // Signed by Shopify but unreadable: a retry would not change it.
    log.error({ event: "webhook.invalid_json" }, "Signed Shopify webhook is not valid JSON; ignored");
    res.json({ ok: true, ignored: true });
    return;
  }

  try {
    if (topic === "orders/paid") {
      const result = await applyShopifyPayment(payload, { topic, deliveryId, shopDomain, apiVersion });
      res.json({ ok: true, outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
      return;
    }
    if (topic === "orders/cancelled" || topic === "refunds/create") {
      res.json(await handleRefundEvent(topic, payload, log));
      return;
    }
    log.info({ event: "webhook.ignored_topic" }, "Shopify webhook topic not handled");
    res.json({ ok: true, ignored: true });
  } catch (err) {
    log.error({ event: "webhook.processing_failed", err }, "Shopify webhook processing failed; Shopify will retry");
    throw err;
  }
});

/**
 * Refunds and cancellations carry Shopify's own ids as the event identity, so
 * a retried or duplicated delivery is applied once (see refundOrder). They
 * only act on the order that Shopify order actually paid for.
 */
async function handleRefundEvent(topic: string, payload: ShopifyOrderPayload, log: typeof logger) {
  const order = await findShopifyOrder(db, payload);
  const shopifyOrderId = String(payload.order_id ?? payload.id ?? "");
  if (!order) {
    log.warn({ event: "webhook.unknown_order", shopifyOrderId }, "Shopify refund/cancel event for an unknown order");
    return { ok: true, ignored: true };
  }
  const rejection = shopifyRefundRejection(order, payload, topic);
  if (rejection) {
    log.warn({ event: "webhook.refund_rejected", reason: rejection, order: order.orderNumber, shopifyOrderId }, "Shopify refund/cancel event does not match the order's payment; not applied");
    await raiseFlag({
      type: "webhook_rejected",
      severity: "high",
      detail: `Shopify ${topic} for Shopify order ${shopifyOrderId} was not applied to ${order.orderNumber} (${rejection.replaceAll("_", " ")}). Review the order and refund manually if needed.`,
      orderId: order.id,
    });
    return { ok: true, outcome: "rejected", reason: rejection };
  }
  try {
    const outcome = await applyRefundEvent(topic, payload, order.id);
    log.info({ event: outcome ? (outcome.replayed ? "refund.duplicate_delivery" : "refund.applied") : "refund.nothing_to_apply", order: order.orderNumber, refundId: outcome?.refundId ?? null }, "Shopify refund/cancel event handled");
    return { ok: true, outcome: outcome ? (outcome.replayed ? "duplicate" : "applied") : "ignored" };
  } catch (err) {
    // Already refunded/cancelled (e.g. the cancellation after a full refund): nothing to do, so
    // acknowledge — a 4xx would only make Shopify retry the event.
    if (err instanceof HttpError && (err.status === 400 || err.status === 409)) {
      log.info({ event: "refund.no_change", order: order.orderNumber, reason: err.message }, "Shopify refund event needs no change");
      return { ok: true, ignored: true };
    }
    throw err;
  }
}

async function applyRefundEvent(topic: string, payload: ShopifyOrderPayload, orderId: number) {
  const actor = "shopify";
  if (topic === "orders/cancelled") {
    return refundOrder(orderId, { type: "cancel", reason: "Cancelled in Shopify", source: "shopify", externalId: `cancel:${payload.id}` }, actor);
  }
  if (!payload.refund_line_items?.length || payload.id == null) return null;
  const variantIds = payload.refund_line_items.map((l) => String(l.line_item?.variant_id ?? "")).filter(Boolean);
  const lines = await db
    .select({ itemId: orderItemsTable.id, variant: productsTable.shopifyVariantId })
    .from(orderItemsTable)
    .innerJoin(productsTable, eq(productsTable.id, orderItemsTable.productId))
    .where(and(eq(orderItemsTable.orderId, orderId), inArray(productsTable.shopifyVariantId, variantIds.flatMap((v) => [v, `gid://shopify/ProductVariant/${v}`]))));
  const items = payload.refund_line_items
    .map((l) => {
      const variant = String(l.line_item?.variant_id ?? "");
      const match = lines.find((x) => x.variant === variant || x.variant === `gid://shopify/ProductVariant/${variant}`);
      return match ? { orderItemId: match.itemId, quantity: l.quantity } : null;
    })
    .filter((x): x is { orderItemId: number; quantity: number } => x != null);
  if (!items.length) return null;
  return refundOrder(orderId, { type: "refund", reason: "Refunded in Shopify", items, source: "shopify", externalId: `refund:${payload.id}` }, actor);
}

export default router;
