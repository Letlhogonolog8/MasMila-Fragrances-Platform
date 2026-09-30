import { Router, type IRouter } from "express";
import { CheckoutBody, CheckoutResponse, TrackOrderQueryParams, TrackOrderResponse } from "@workspace/api-zod";
import { db, ordersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createOrder, getOrderView } from "../lib/orders";
import { notFound } from "../lib/http";

const router: IRouter = Router();

router.post("/checkout", async (req, res) => {
  const input = CheckoutBody.parse(req.body);
  const result = await createOrder(input, { user: req.currentUser ?? null, reseller: req.currentReseller ?? null });
  const order = await getOrderView(result.orderId);
  res.status(201).json(
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
