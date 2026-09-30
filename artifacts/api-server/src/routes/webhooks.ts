import express, { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db, orderItemsTable, ordersTable, productsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { markOrderPaid, refundOrder } from "../lib/orders";
import { logger } from "../lib/logger";

/**
 * Shopify webhooks (orders/paid, orders/cancelled, refunds/create). Mounted
 * before the JSON body parser because the HMAC is computed over the raw body.
 * Configure in Shopify admin → Settings → Notifications → Webhooks with
 * URL https://<host>/api/webhooks/shopify and SHOPIFY_WEBHOOK_SECRET.
 */
const router: IRouter = Router();

function verify(raw: Buffer, signature: string | undefined) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const digest = createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(signature, "base64");
  return given.length === digest.length && timingSafeEqual(given, digest);
}

type ShopifyOrderPayload = {
  id?: number;
  order_id?: number;
  name?: string;
  note_attributes?: Array<{ name: string; value: string }>;
  refund_line_items?: Array<{ quantity: number; line_item?: { variant_id?: number } }>;
};

async function findOrder(payload: ShopifyOrderPayload) {
  const attribute = payload.note_attributes?.find((a) => a.name === "masmila_order")?.value;
  if (attribute) {
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.orderNumber, attribute));
    if (order) return order;
  }
  const shopifyId = String(payload.order_id ?? payload.id ?? "");
  if (!shopifyId) return undefined;
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.shopifyOrderId, shopifyId));
  return order;
}

router.post("/webhooks/shopify", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verify(raw, req.get("X-Shopify-Hmac-Sha256"))) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  const topic = req.get("X-Shopify-Topic") ?? "";
  const payload = JSON.parse(raw.toString("utf8")) as ShopifyOrderPayload;
  const order = await findOrder(payload);
  if (!order) {
    logger.warn({ topic, shopifyId: payload.id }, "Shopify webhook for unknown order");
    res.json({ ok: true, ignored: true });
    return;
  }
  const actor = "shopify";
  if (topic === "orders/paid") {
    await markOrderPaid(order.id, actor, { shopifyOrderId: String(payload.id), paymentReference: payload.name });
  } else if (topic === "orders/cancelled") {
    await refundOrder(order.id, { type: "cancel", reason: "Cancelled in Shopify" }, actor);
  } else if (topic === "refunds/create" && payload.refund_line_items?.length) {
    const variantIds = payload.refund_line_items.map((l) => String(l.line_item?.variant_id ?? "")).filter(Boolean);
    const lines = await db
      .select({ itemId: orderItemsTable.id, variant: productsTable.shopifyVariantId })
      .from(orderItemsTable)
      .innerJoin(productsTable, eq(productsTable.id, orderItemsTable.productId))
      .where(and(eq(orderItemsTable.orderId, order.id), inArray(productsTable.shopifyVariantId, variantIds.flatMap((v) => [v, `gid://shopify/ProductVariant/${v}`]))));
    const items = payload.refund_line_items
      .map((l) => {
        const variant = String(l.line_item?.variant_id ?? "");
        const match = lines.find((x) => x.variant === variant || x.variant === `gid://shopify/ProductVariant/${variant}`);
        return match ? { orderItemId: match.itemId, quantity: l.quantity } : null;
      })
      .filter((x): x is { orderItemId: number; quantity: number } => x != null);
    if (items.length) await refundOrder(order.id, { type: "refund", reason: "Refunded in Shopify", items }, actor);
  }
  res.json({ ok: true });
});

export default router;
