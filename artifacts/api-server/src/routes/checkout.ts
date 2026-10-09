import { Router, type IRouter } from "express";
import { CheckoutBody, CheckoutResponse, TrackOrderQueryParams, TrackOrderResponse } from "@workspace/api-zod";
import { db, ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createOrder, getOrderView } from "../lib/orders";
import { HttpError, notFound } from "../lib/http";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * Place an order. With an idempotencyKey, a retried or double-submitted
 * request returns the order the first one created (200) instead of a second
 * order (201).
 */
router.post("/checkout", async (req, res) => {
  const input = CheckoutBody.parse(req.body);
  let result: Awaited<ReturnType<typeof createOrder>>;
  try {
    result = await createOrder(input, { user: req.currentUser ?? null, reseller: req.currentReseller ?? null });
  } catch (err) {
    // No customer details in the log: mode, size and the reason are enough to spot a pattern.
    const status = err instanceof HttpError ? err.status : 500;
    const fields = { event: status >= 500 ? "checkout.failed" : "checkout.refused", status, mode: input.mode, lines: input.items.length, paymentMethod: input.paymentMethod };
    if (status >= 500) logger.error({ ...fields, err }, "Checkout failed");
    else logger.info({ ...fields, reason: (err as Error).message }, "Checkout refused");
    throw err;
  }
  const order = await getOrderView(result.orderId);
  res.status(result.replayed ? 200 : 201).json(
    CheckoutResponse.parse({ order, checkoutUrl: result.checkoutUrl, paymentInstructions: result.paymentInstructions }),
  );
});

/** Public order tracking by order number + email (no account required). */
router.get("/orders/track", async (req, res) => {
  const { orderNumber, email } = TrackOrderQueryParams.parse(req.query);
  const [order] = await db
    .select({ id: ordersTable.id })
    .from(ordersTable)
    .where(and(eq(ordersTable.orderNumber, orderNumber.trim().toUpperCase()), eq(ordersTable.customerEmail, email.trim().toLowerCase())));
  if (!order) throw notFound("We couldn't find an order with that number and email address.");
  res.json(TrackOrderResponse.parse(await getOrderView(order.id)));
});

export default router;
