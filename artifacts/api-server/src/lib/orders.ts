import {
  db,
  commissionLedgerTable,
  orderItemsTable,
  ordersTable,
  productsTable,
  resellersTable,
  usersTable,
  type Order,
  type OrderItem,
  type Reseller,
  type User,
} from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { available } from "./catalog";
import { bulkDiscountFor, getSettings, shippingFor } from "./settings";
import { periodOf } from "./period";
import { badRequest, forbidden, HttpError, iso, notFound, round2 } from "./http";
import { isUniqueViolation, orderNumber } from "./codes";
import { audit } from "./audit";
import { notifyAdmins, notifyEmail, notifyUser } from "./notify";
import { checkOrder, raiseFlag } from "./fraud";
import { accrueOrderIncentives, PAID_STATUSES, refreshLiveStatus, resellerNames, reverseLineIncentives } from "./network";
import { createShopifyCheckout, isShopifyConfigured } from "./shopifyStorefrontClient";
import { logger } from "./logger";

export type CheckoutInput = {
  mode: "retail" | "reseller";
  items: Array<{ productId: number; quantity: number }>;
  customer: { firstName: string; surname: string; email: string; mobile: string };
  address: { line1: string; line2?: string | null; suburb?: string | null; city: string; province: string; postalCode: string };
  paymentMethod: "eft" | "shopify";
  referralCode?: string | null;
  attributionSource?: string | null;
  notes?: string | null;
  saveAddress?: boolean;
};

const ATTRIBUTION_SOURCES = new Set(["link", "code", "qr", "landing", "manual"]);

async function insertWithUniqueNumber(values: Omit<typeof ordersTable.$inferInsert, "orderNumber">, tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const [row] = await tx.insert(ordersTable).values({ ...values, orderNumber: orderNumber() }).returning();
      return row!;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 5) throw err;
    }
  }
  throw new Error("unreachable");
}

export async function createOrder(input: CheckoutInput, ctx: { user: User | null; reseller: Reseller | null }) {
  const settings = await getSettings();
  const email = input.customer.email.trim().toLowerCase();

  if (ctx.user && ["hold", "suspended"].includes(ctx.user.accountStatus)) {
    throw forbidden("This account is on hold. Please contact Mas'Mila to complete your order.");
  }

  const quantities = new Map<number, number>();
  for (const item of input.items) quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  const products = await db.select().from(productsTable).where(inArray(productsTable.id, [...quantities.keys()]));
  if (products.length !== quantities.size) throw badRequest("One or more items in your bag are no longer available.");
  for (const product of products) {
    if (product.status !== "active") throw badRequest(`${product.name} (${product.size}) is no longer available.`);
    const left = available(product);
    if (left < quantities.get(product.id)!) {
      throw new HttpError(409, left > 0 ? `Only ${left} × ${product.name} (${product.size}) left in stock.` : `${product.name} (${product.size}) is sold out.`);
    }
  }
  const bottles = [...quantities.values()].reduce((a, b) => a + b, 0);

  // Reseller (wholesale) ordering — approved resellers only, minimums enforced.
  const reseller = input.mode === "reseller" ? ctx.reseller : null;
  if (input.mode === "reseller") {
    if (!ctx.user || !reseller) throw forbidden("Reseller ordering is only available to approved Mas'Mila resellers.");
    if (reseller.standing !== "good" && reseller.standing !== "review") {
      throw forbidden("Your reseller account is on hold. Please contact Mas'Mila before placing stock orders.");
    }
    const minimum = reseller.openingOrderCompleted ? settings.reorderMinimum : settings.openingOrder;
    if (bottles < minimum) {
      throw badRequest(
        reseller.openingOrderCompleted
          ? `Reseller re-orders need at least ${minimum} bottle${minimum === 1 ? "" : "s"}.`
          : `Your opening order needs at least ${minimum} bottles (mixed fragrances allowed). You have ${bottles}.`,
      );
    }
  }

  // Referral attribution for retail sales (link, code, QR, landing page).
  let attributedResellerId: number | null = null;
  let attributionSource: string | null = null;
  let referralCode: string | null = null;
  let selfReferral: { resellerId: number } | null = null;
  if (input.mode === "retail" && input.referralCode?.trim()) {
    referralCode = input.referralCode.trim().toUpperCase();
    const [match] = await db
      .select({ reseller: resellersTable, email: usersTable.email, mobile: usersTable.mobile })
      .from(resellersTable)
      .innerJoin(usersTable, eq(usersTable.id, resellersTable.userId))
      .where(eq(resellersTable.referralCode, referralCode));
    if (match && match.reseller.standing !== "suspended") {
      const sameMobile = match.mobile && match.mobile.replace(/\D/g, "").slice(-9) === input.customer.mobile.replace(/\D/g, "").slice(-9);
      if (match.reseller.userId === ctx.user?.id || match.email === email || sameMobile) {
        selfReferral = { resellerId: match.reseller.id };
      } else {
        attributedResellerId = match.reseller.id;
        attributionSource = ATTRIBUTION_SOURCES.has(input.attributionSource ?? "") ? input.attributionSource! : "code";
      }
    }
  }

  // Admin-configured bulk pricing on reseller stock orders (mixed fragrances count together).
  const bulkPercent = input.mode === "reseller" ? bulkDiscountFor(bottles, settings) : 0;
  const lines = products.map((p) => {
    const quantity = quantities.get(p.id)!;
    const unitPrice = input.mode === "reseller" ? round2(p.resellerPrice * (1 - bulkPercent / 100)) : p.retailPrice;
    // Qualifying (wholesale) value: what a reseller actually paid; list reseller price for retail sales.
    const unitWholesale = input.mode === "reseller" ? unitPrice : p.resellerPrice;
    return { product: p, quantity, unitPrice, unitWholesale };
  });
  const subtotal = round2(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
  const shippingFee = shippingFor(subtotal, settings);
  const wantsShopify =
    input.mode === "retail" && input.paymentMethod === "shopify" && isShopifyConfigured() && lines.every((l) => l.product.shopifyVariantId);

  const order = await db.transaction(async (tx) => {
    const created = await insertWithUniqueNumber(
      {
        channel: input.mode,
        userId: ctx.user?.id ?? null,
        resellerId: reseller?.id ?? null,
        attributedResellerId,
        attributionSource,
        referralCode,
        customerFirstName: input.customer.firstName.trim(),
        customerSurname: input.customer.surname.trim(),
        customerEmail: email,
        customerMobile: input.customer.mobile.trim(),
        addressLine1: input.address.line1.trim(),
        addressLine2: input.address.line2?.trim() || null,
        suburb: input.address.suburb?.trim() || null,
        city: input.address.city.trim(),
        province: input.address.province.trim(),
        postalCode: input.address.postalCode.trim(),
        bottles,
        subtotal,
        shippingFee,
        total: round2(subtotal + shippingFee),
        wholesaleValue: round2(lines.reduce((sum, l) => sum + l.unitWholesale * l.quantity, 0)),
        costValue: round2(lines.reduce((sum, l) => sum + l.product.cost * l.quantity, 0)),
        paymentMethod: wantsShopify ? "shopify" : "eft",
        notes: input.notes?.trim() || null,
      },
      tx,
    );
    await tx.insert(orderItemsTable).values(
      lines.map((l) => ({
        orderId: created.id,
        productId: l.product.id,
        sku: l.product.sku,
        name: l.product.name,
        size: l.product.size,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        unitWholesale: l.unitWholesale,
        unitCost: l.product.cost,
      })),
    );
    // Reserve stock atomically so two shoppers cannot buy the last bottle.
    for (const l of lines) {
      const reserved = await tx
        .update(productsTable)
        .set({ reservedQuantity: sql`${productsTable.reservedQuantity} + ${l.quantity}` })
        .where(and(eq(productsTable.id, l.product.id), gte(sql`${productsTable.stockQuantity} - ${productsTable.reservedQuantity}`, l.quantity)))
        .returning({ id: productsTable.id });
      if (!reserved.length) throw new HttpError(409, `${l.product.name} (${l.product.size}) just sold out. Please update your bag.`);
    }
    return created;
  });

  let checkoutUrl: string | null = null;
  if (wantsShopify) {
    try {
      checkoutUrl = await createShopifyCheckout({
        lines: lines.map((l) => ({ merchandiseId: l.product.shopifyVariantId!, quantity: l.quantity })),
        email,
        attributes: { masmila_order: order.orderNumber, ...(referralCode && attributedResellerId ? { referral_code: referralCode } : {}) },
      });
      await db.update(ordersTable).set({ checkoutUrl }).where(eq(ordersTable.id, order.id));
    } catch (err) {
      logger.error({ err, order: order.orderNumber }, "Shopify checkout failed; falling back to EFT");
      await db.update(ordersTable).set({ paymentMethod: "eft" }).where(eq(ordersTable.id, order.id));
      order.paymentMethod = "eft";
    }
  }

  if (ctx.user && input.saveAddress) {
    await db
      .update(usersTable)
      .set({
        firstName: ctx.user.firstName || input.customer.firstName,
        surname: ctx.user.surname || input.customer.surname,
        mobile: ctx.user.mobile || input.customer.mobile,
        addressLine1: input.address.line1,
        addressLine2: input.address.line2 ?? null,
        suburb: input.address.suburb ?? null,
        city: input.address.city,
        province: input.address.province,
        postalCode: input.address.postalCode,
      })
      .where(eq(usersTable.id, ctx.user.id));
  }

  if (selfReferral) {
    await raiseFlag({
      type: "self_referral",
      severity: "high",
      detail: `Order ${order.orderNumber} used the buyer's own referral code ${referralCode}; the sale was not attributed.`,
      orderId: order.id,
      resellerId: selfReferral.resellerId,
      userId: ctx.user?.id,
    });
  }
  await checkOrder(order);
  await audit("order_created", "order", order.orderNumber, ctx.user, { channel: order.channel, total: order.total, bottles, attributedResellerId });
  const message = `We have received order ${order.orderNumber} (R${order.total.toFixed(2)}).`;
  if (ctx.user) await notifyUser(ctx.user.id, "order_received", "Order received", message, `/account?order=${order.orderNumber}`);
  else await notifyEmail(email, "Order received", message);
  if (order.channel === "reseller") {
    await notifyAdmins("reseller_order", "New reseller order", `${order.orderNumber}: ${bottles} bottles awaiting payment.`, "/admin?tab=orders");
  }

  const paymentInstructions =
    order.paymentMethod === "eft"
      ? `Pay R${order.total.toFixed(2)} by EFT using reference ${order.orderNumber}. Your order ships once payment reflects (usually 1–2 business days).`
      : null;
  return { orderId: order.id, checkoutUrl, paymentInstructions };
}

/** Idempotent: settles payment, stock, activation and incentives. */
export async function markOrderPaid(orderId: number, actor: { id: number } | string | null, details: { paymentReference?: string; shopifyOrderId?: string } = {}) {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) throw notFound("Order not found");
  if (order.status !== "awaiting_payment") return order;
  const paidAt = new Date();
  const period = periodOf(paidAt);
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(ordersTable)
      .set({
        status: "paid",
        paidAt,
        period,
        paymentReference: details.paymentReference ?? order.paymentReference ?? order.orderNumber,
        shopifyOrderId: details.shopifyOrderId ?? order.shopifyOrderId,
        updatedAt: paidAt,
      })
      .where(and(eq(ordersTable.id, orderId), eq(ordersTable.status, "awaiting_payment")))
      .returning();
    if (!row) return null;
    for (const item of items) {
      await tx
        .update(productsTable)
        .set({
          stockQuantity: sql`greatest(${productsTable.stockQuantity} - ${item.quantity}, 0)`,
          reservedQuantity: sql`greatest(${productsTable.reservedQuantity} - ${item.quantity}, 0)`,
          updatedAt: paidAt,
        })
        .where(eq(productsTable.id, item.productId));
    }
    if (row.channel === "reseller" && row.resellerId != null) {
      await tx
        .update(resellersTable)
        .set({ lastOrderAt: paidAt, openingOrderCompleted: true })
        .where(eq(resellersTable.id, row.resellerId));
    }
    return row;
  });
  if (!updated) {
    const [current] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    return current!;
  }

  await audit("order_paid", "order", updated.orderNumber, actor, { total: updated.total, period });
  const seller = updated.channel === "reseller" ? updated.resellerId : updated.attributedResellerId;
  await accrueOrderIncentives(updated.id);
  if (seller != null) await refreshLiveStatus(seller, period);

  // Customer + reseller notifications.
  const paymentMessage = `Payment received for ${updated.orderNumber}. We're preparing your fragrances for dispatch.`;
  if (updated.userId) {
    await notifyUser(updated.userId, updated.channel === "reseller" ? "order_confirmed" : "payment_received", updated.channel === "reseller" ? "Order confirmed" : "Payment received", paymentMessage, `/account?order=${updated.orderNumber}`);
  } else {
    await notifyEmail(updated.customerEmail, "Payment received", paymentMessage);
  }
  if (updated.attributedResellerId != null) {
    const [r] = await db.select().from(resellersTable).where(eq(resellersTable.id, updated.attributedResellerId));
    if (r) await notifyUser(r.userId, "referral_sale", "New customer sale", `A customer bought ${updated.bottles} bottle${updated.bottles === 1 ? "" : "s"} through your referral link (${updated.orderNumber}).`, "/account/reseller?tab=sales");
  }
  await lowStockAlerts(items.map((i) => i.productId));
  return updated;
}

async function lowStockAlerts(productIds: number[]) {
  if (!productIds.length) return;
  const rows = await db.select().from(productsTable).where(inArray(productsTable.id, productIds));
  for (const p of rows) {
    const left = available(p);
    if (left <= p.lowStockThreshold) {
      await notifyAdmins("low_stock", "LOW STOCK ALERT", `${p.name} ${p.size} (${p.sku}) has ${left} available (threshold ${p.lowStockThreshold}).`, "/admin?tab=products");
    }
  }
}

export async function updateFulfilment(
  orderId: number,
  patch: { status?: "paid" | "processing" | "shipped" | "delivered"; courier?: string | null; trackingNumber?: string | null; notes?: string | null; attributedReferralCode?: string | null },
  actor: { id: number },
) {
  let [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) throw notFound("Order not found");

  if (patch.status === "paid") {
    order = await markOrderPaid(orderId, actor, { paymentReference: `ADMIN-${actor.id}` });
  }

  const changes: Partial<Order> = { updatedAt: new Date() };
  if (patch.courier !== undefined) changes.courier = patch.courier;
  if (patch.trackingNumber !== undefined) changes.trackingNumber = patch.trackingNumber;
  if (patch.notes !== undefined) changes.notes = patch.notes;
  if (patch.status === "processing" || patch.status === "shipped" || patch.status === "delivered") {
    if (!PAID_STATUSES.includes(order.status)) throw badRequest("Only paid orders can be processed, shipped or delivered.");
    changes.status = patch.status;
    if (patch.status === "shipped") changes.shippedAt = new Date();
    if (patch.status === "delivered") changes.deliveredAt = new Date();
  }

  // Manual attribution by administrator (retail sales only, before settlement is paid out).
  if (patch.attributedReferralCode !== undefined) {
    if (order.channel !== "retail") throw badRequest("Only retail orders can be attributed to a reseller.");
    const code = patch.attributedReferralCode?.trim().toUpperCase() || null;
    let attributedResellerId: number | null = null;
    if (code) {
      const [r] = await db.select().from(resellersTable).where(eq(resellersTable.referralCode, code));
      if (!r) throw badRequest(`No reseller has referral code ${code}.`);
      const [u] = await db.select().from(usersTable).where(eq(usersTable.id, r.userId));
      if (u?.email === order.customerEmail) throw badRequest("A reseller cannot be credited for their own purchase.");
      attributedResellerId = r.id;
    }
    if (attributedResellerId !== order.attributedResellerId) {
      const [paid] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(commissionLedgerTable)
        .where(and(eq(commissionLedgerTable.orderId, order.id), inArray(commissionLedgerTable.status, ["approved", "paid"])));
      if ((paid?.count ?? 0) > 0) throw badRequest("Incentives for this order are already approved or paid; refund and re-issue instead.");
      await db
        .update(commissionLedgerTable)
        .set({ status: "void", note: "Attribution changed by administrator", updatedAt: new Date() })
        .where(and(eq(commissionLedgerTable.orderId, order.id), eq(commissionLedgerTable.status, "pending")));
      changes.attributedResellerId = attributedResellerId;
      changes.referralCode = code;
      changes.attributionSource = code ? "manual" : null;
      await audit("order_attribution_changed", "order", order.orderNumber, actor, { from: order.attributedResellerId, to: attributedResellerId });
    }
  }

  const [updated] = await db.update(ordersTable).set(changes).where(eq(ordersTable.id, orderId)).returning();
  if (changes.attributedResellerId !== undefined && PAID_STATUSES.includes(updated!.status)) {
    await accrueOrderIncentives(updated!.id);
    if (updated!.attributedResellerId && updated!.period) await refreshLiveStatus(updated!.attributedResellerId, updated!.period);
  }
  if (patch.status && patch.status !== "paid") {
    await audit(`order_${patch.status}`, "order", order.orderNumber, actor, { courier: changes.courier, trackingNumber: changes.trackingNumber });
    const text =
      patch.status === "shipped"
        ? `Order ${order.orderNumber} is on its way${updated!.courier ? ` with ${updated!.courier}` : ""}${updated!.trackingNumber ? ` (tracking ${updated!.trackingNumber})` : ""}.`
        : patch.status === "delivered"
          ? `Order ${order.orderNumber} has been delivered. Enjoy your Mas'Mila fragrance!`
          : `Order ${order.orderNumber} is being packed.`;
    const title = patch.status === "shipped" ? "Order shipped" : patch.status === "delivered" ? "Order delivered" : "Order processing";
    if (order.userId) await notifyUser(order.userId, `order_${patch.status}`, title, text, `/account?order=${order.orderNumber}`);
    else await notifyEmail(order.customerEmail, title, text);
  }
  return updated!;
}

/**
 * Cancel, refund, return or charge back all or part of an order. Stock is
 * restored for cancellations and returns; associated incentives are
 * reversed automatically.
 */
export async function refundOrder(
  orderId: number,
  input: { type: "refund" | "cancel" | "return" | "chargeback"; reason: string; items?: Array<{ orderItemId: number; quantity: number }> },
  actor: { id: number } | string,
) {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) throw notFound("Order not found");
  const items = await db.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, orderId));

  if (order.status === "awaiting_payment") {
    await db.transaction(async (tx) => {
      for (const item of items) {
        await tx
          .update(productsTable)
          .set({ reservedQuantity: sql`greatest(${productsTable.reservedQuantity} - ${item.quantity}, 0)` })
          .where(eq(productsTable.id, item.productId));
      }
      await tx.update(ordersTable).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    });
    await audit("order_cancelled", "order", order.orderNumber, actor, { reason: input.reason, unpaid: true });
    return order.id;
  }
  if (!PAID_STATUSES.includes(order.status)) throw badRequest(`Order is already ${order.status.replaceAll("_", " ")}.`);

  const requested = new Map<number, number>();
  const byId = new Map(items.map((i) => [i.id, i]));
  if (input.items?.length) {
    for (const r of input.items) {
      const item = byId.get(r.orderItemId);
      if (!item) throw badRequest(`Item ${r.orderItemId} is not part of this order.`);
      requested.set(item.id, Math.min(r.quantity, item.quantity - item.refundedQuantity));
    }
  } else {
    for (const item of items) requested.set(item.id, item.quantity - item.refundedQuantity);
  }
  const restock = input.type === "cancel" || input.type === "return";
  const reason = `${input.type}: ${input.reason}`;
  const paidRowsAffected: Array<{ id: number }> = [];

  for (const [itemId, quantity] of requested) {
    if (quantity <= 0) continue;
    const item = byId.get(itemId)!;
    const refundedQuantity = item.refundedQuantity + quantity;
    await db.update(orderItemsTable).set({ refundedQuantity }).where(eq(orderItemsTable.id, itemId));
    if (restock) {
      await db.update(productsTable).set({ stockQuantity: sql`${productsTable.stockQuantity} + ${quantity}` }).where(eq(productsTable.id, item.productId));
    }
    paidRowsAffected.push(...(await reverseLineIncentives(itemId, quantity, refundedQuantity >= item.quantity, reason)));
    item.refundedQuantity = refundedQuantity;
  }

  const fully = items.every((i) => i.refundedQuantity >= i.quantity);
  const status = fully ? (input.type === "cancel" ? "cancelled" : "refunded") : "partially_refunded";
  await db
    .update(ordersTable)
    .set({ status, updatedAt: new Date(), ...(status === "cancelled" ? { cancelledAt: new Date() } : {}) })
    .where(eq(ordersTable.id, orderId));
  await audit(`order_${input.type}`, "order", order.orderNumber, actor, { reason: input.reason, items: Object.fromEntries(requested), status });

  if (paidRowsAffected.length) {
    await raiseFlag({
      type: "refund_commission",
      severity: "high",
      detail: `${input.type} on ${order.orderNumber} affects ${paidRowsAffected.length} incentive payment(s) already paid out; clawback entries were created.`,
      orderId: order.id,
    });
  }
  const seller = order.channel === "reseller" ? order.resellerId : order.attributedResellerId;
  if (seller != null && order.period) await refreshLiveStatus(seller, order.period);
  const text = `Your ${input.type === "chargeback" ? "chargeback" : input.type} for order ${order.orderNumber} has been processed.`;
  if (order.userId) await notifyUser(order.userId, "order_refunded", "Order update", text, `/account?order=${order.orderNumber}`);
  else await notifyEmail(order.customerEmail, "Order update", text);
  return order.id;
}

/** Shape orders for the API. Admin views include cost, margin and incentive data. */
export async function serializeOrders(orders: Order[], opts: { admin?: boolean; maskCustomer?: boolean } = {}) {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const items = await db
    .select({ item: orderItemsTable, slug: productsTable.slug })
    .from(orderItemsTable)
    .innerJoin(productsTable, eq(productsTable.id, orderItemsTable.productId))
    .where(inArray(orderItemsTable.orderId, ids));
  const itemsByOrder = new Map<number, Array<{ item: OrderItem; slug: string }>>();
  for (const row of items) itemsByOrder.set(row.item.orderId, [...(itemsByOrder.get(row.item.orderId) ?? []), row]);
  const names = await resellerNames(orders.flatMap((o) => [o.attributedResellerId, o.resellerId]).filter((id): id is number => id != null));
  const incentives = opts.admin
    ? new Map(
        (
          await db
            .select({ orderId: commissionLedgerTable.orderId, total: sql<string>`sum(${commissionLedgerTable.amount})` })
            .from(commissionLedgerTable)
            .where(and(inArray(commissionLedgerTable.orderId, ids), inArray(commissionLedgerTable.status, ["pending", "approved", "paid"])))
            .groupBy(commissionLedgerTable.orderId)
        ).map((r) => [r.orderId, Number(r.total)]),
      )
    : new Map<number, number>();

  return orders.map((o) => {
    const attributed = o.attributedResellerId != null ? names.get(o.attributedResellerId) : undefined;
    const lines = itemsByOrder.get(o.id) ?? [];
    const netRevenue = lines.reduce((sum, l) => sum + l.item.unitPrice * (l.item.quantity - l.item.refundedQuantity), 0);
    const netCost = lines.reduce((sum, l) => sum + l.item.unitCost * (l.item.quantity - l.item.refundedQuantity), 0);
    const customerName = opts.maskCustomer ? `${o.customerFirstName} ${o.customerSurname.charAt(0)}.` : `${o.customerFirstName} ${o.customerSurname}`;
    return {
      id: o.id,
      orderNumber: o.orderNumber,
      channel: o.channel,
      status: o.status,
      paymentMethod: o.paymentMethod,
      paymentReference: o.paymentReference,
      customerName,
      customerEmail: opts.maskCustomer ? o.customerEmail.replace(/^(.).*(@.*)$/, "$1•••$2") : o.customerEmail,
      customerMobile: opts.maskCustomer ? `•••${o.customerMobile.slice(-3)}` : o.customerMobile,
      shippingAddress: opts.maskCustomer
        ? `${o.city}, ${o.province}`
        : [o.addressLine1, o.addressLine2, o.suburb, o.city, o.province, o.postalCode].filter(Boolean).join(", "),
      bottles: o.bottles,
      subtotal: o.subtotal,
      shippingFee: o.shippingFee,
      total: o.total,
      courier: o.courier,
      trackingNumber: o.trackingNumber,
      referralCode: o.referralCode,
      attributedReseller: attributed ? `${attributed.name} (${attributed.code})` : null,
      createdAt: o.createdAt.toISOString(),
      paidAt: iso(o.paidAt),
      shippedAt: iso(o.shippedAt),
      deliveredAt: iso(o.deliveredAt),
      items: lines.map(({ item, slug }) => ({
        id: item.id,
        productId: item.productId,
        slug,
        name: item.name,
        sku: item.sku,
        size: item.size,
        quantity: item.quantity,
        refundedQuantity: item.refundedQuantity,
        unitPrice: item.unitPrice,
        lineTotal: round2(item.unitPrice * item.quantity),
      })),
      ...(opts.admin
        ? {
            wholesaleValue: o.wholesaleValue,
            costValue: round2(netCost),
            grossProfit: round2(netRevenue - netCost),
            attributionSource: o.attributionSource,
            buyerResellerCode: o.resellerId != null ? (names.get(o.resellerId)?.code ?? null) : null,
            incentiveTotal: round2(incentives.get(o.id) ?? 0),
            notes: o.notes,
          }
        : {}),
    };
  });
}

export async function getOrderView(orderId: number, opts: { admin?: boolean } = {}) {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) throw notFound("Order not found");
  return (await serializeOrders([order], opts))[0]!;
}
