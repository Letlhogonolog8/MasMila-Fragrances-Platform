/**
 * Payment verification rules (pure — no database is contacted): which Shopify
 * orders/paid notifications may settle an order, signature checking, and the
 * order-number format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// The modules import @workspace/db, which needs a URL to build its (lazy) pool; nothing connects.
process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
process.env.LOG_LEVEL = "silent";
const { assessShopifyPayment, shopifyRefundRejection, toCents } = await import("./payments");
const { verifyShopifySignature } = await import("../routes/webhooks");
const { orderNumber } = await import("./codes");

const order = {
  orderNumber: "MM-261009-00042",
  status: "awaiting_payment",
  paymentMethod: "shopify",
  paymentReference: null as string | null,
  shopifyOrderId: null as string | null,
  total: 419.85,
};
const paid = {
  id: 5550001,
  name: "#1042",
  financial_status: "paid",
  currency: "ZAR",
  total_price: "419.85",
  total_price_set: { shop_money: { amount: "419.85", currency_code: "ZAR" } },
  total_outstanding: "0.00",
  test: false,
  cancelled_at: null,
  note_attributes: [{ name: "masmila_order", value: "MM-261009-00042" }],
};
const reason = (o: Partial<typeof order>, p: Record<string, unknown> = {}) => {
  const result = assessShopifyPayment({ ...order, ...o }, { ...paid, ...p });
  return result.verdict === "reject" ? result.reason : result.verdict;
};

test("an exact, complete ZAR payment for the order's own Shopify checkout is applied", () => {
  assert.equal(reason({}), "apply");
  // total_outstanding absent (older payloads): treated as fully paid when status is "paid".
  assert.equal(reason({}, { total_outstanding: undefined }), "apply");
});

test("amount must match to the cent", () => {
  assert.equal(reason({}, { total_price_set: { shop_money: { amount: "419.84", currency_code: "ZAR" } } }), "underpayment");
  assert.equal(reason({}, { total_price_set: { shop_money: { amount: "1.00", currency_code: "ZAR" } } }), "underpayment");
  assert.equal(reason({}, { total_price_set: { shop_money: { amount: "419.86", currency_code: "ZAR" } } }), "overpayment");
  assert.equal(reason({}, { total_price_set: { shop_money: { amount: "abc", currency_code: "ZAR" } } }), "invalid_payload");
  assert.equal(reason({}, { total_price_set: undefined, total_price: undefined }), "invalid_payload");
  // Falls back to total_price when total_price_set is absent.
  assert.equal(reason({}, { total_price_set: undefined, total_price: "419.85" }), "apply");
});

test("currency must be ZAR (shop money)", () => {
  assert.equal(reason({}, { total_price_set: { shop_money: { amount: "419.85", currency_code: "USD" } } }), "currency_mismatch");
  assert.equal(reason({}, { total_price_set: { shop_money: { amount: "419.85" } }, currency: "EUR" }), "currency_mismatch");
});

test("partial, pending, voided, cancelled and test payments are rejected", () => {
  assert.equal(reason({}, { financial_status: "partially_paid" }), "partial_payment");
  assert.equal(reason({}, { total_outstanding: "100.00" }), "partial_payment");
  assert.equal(reason({}, { financial_status: "pending" }), "not_paid");
  assert.equal(reason({}, { financial_status: "authorized" }), "not_paid");
  assert.equal(reason({}, { financial_status: undefined }), "not_paid");
  assert.equal(reason({}, { cancelled_at: "2026-10-09T10:00:00+02:00" }), "shopify_order_cancelled");
  assert.equal(reason({}, { test: true }), "test_payment");
  assert.equal(assessShopifyPayment(order, { ...paid, test: true }, { allowTest: true }).verdict, "apply");
});

test("staging settles only test payments: a live payment is quarantined, whatever its amount", () => {
  const staging = { allowTest: true, requireTest: true };
  const live = assessShopifyPayment(order, paid, staging);
  assert.equal(live.verdict === "reject" ? live.reason : live.verdict, "live_payment_in_staging");
  const missingFlag = assessShopifyPayment(order, { ...paid, test: undefined }, staging);
  assert.equal(missingFlag.verdict === "reject" ? missingFlag.reason : missingFlag.verdict, "live_payment_in_staging", "no test flag = treated as live");
  assert.equal(assessShopifyPayment(order, { ...paid, test: true }, staging).verdict, "apply");
  // Every other check still applies to test payments on staging.
  const wrong = assessShopifyPayment(order, { ...paid, test: true, total_price_set: { shop_money: { amount: "1.00", currency_code: "ZAR" } } }, staging);
  assert.equal(wrong.verdict === "reject" ? wrong.reason : wrong.verdict, "underpayment");
});

test("the payment must belong to this order", () => {
  const unknown = assessShopifyPayment(undefined, paid);
  assert.equal(unknown.verdict === "reject" ? unknown.reason : unknown.verdict, "unknown_order");
  assert.equal(reason({}, { id: undefined }), "invalid_payload");
  assert.equal(reason({}, { note_attributes: [{ name: "masmila_order", value: "MM-261009-00043" }] }), "reference_mismatch");
  assert.equal(reason({ shopifyOrderId: "9999" }), "reference_mismatch");
  assert.equal(reason({ paymentMethod: "eft" }), "payment_method_mismatch");
});

test("already-paid, duplicate, refunded and cancelled orders", () => {
  assert.equal(reason({ status: "paid", shopifyOrderId: "5550001" }), "already_applied");
  assert.equal(reason({ status: "shipped", shopifyOrderId: "5550001" }), "already_applied");
  assert.equal(reason({ status: "paid", shopifyOrderId: "5550002" }), "duplicate_payment");
  assert.equal(reason({ status: "paid", paymentReference: "ADMIN-1" }), "duplicate_payment");
  assert.equal(reason({ status: "refunded" }), "order_refunded");
  assert.equal(reason({ status: "partially_refunded" }), "order_refunded");
  assert.equal(reason({ status: "cancelled" }), "order_cancelled");
});

test("Shopify refunds/cancellations only act on the order their Shopify order paid", () => {
  const linked = { ...order, status: "paid", shopifyOrderId: "5550001" };
  assert.equal(shopifyRefundRejection(linked, { order_id: 5550001 }, "refunds/create"), null);
  assert.equal(shopifyRefundRejection(linked, { order_id: 5550002 }, "refunds/create"), "reference_mismatch");
  assert.equal(shopifyRefundRejection(linked, { id: 5550001 }, "orders/cancelled"), null);
  // Unlinked: only an unpaid Shopify checkout can be cancelled from Shopify.
  assert.equal(shopifyRefundRejection(order, { id: 5550001 }, "orders/cancelled"), null);
  assert.equal(shopifyRefundRejection({ ...order, status: "paid" }, { id: 5550001 }, "orders/cancelled"), "unverified_payment");
  assert.equal(shopifyRefundRejection({ ...order, paymentMethod: "eft" }, { id: 5550001 }, "orders/cancelled"), "payment_method_mismatch");
  assert.equal(shopifyRefundRejection({ ...order, paymentMethod: "eft", status: "paid" }, { order_id: 5550001 }, "refunds/create"), "payment_method_mismatch");
});

test("money strings convert to exact cents", () => {
  assert.equal(toCents("19.99"), 1999);
  assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("419.85"), 41985);
  assert.equal(toCents("1e3"), null);
  assert.equal(toCents("-5.00"), null);
  assert.equal(toCents(5), null);
});

test("webhook signature: HMAC-SHA256 of the raw body, base64, with the configured secret", () => {
  const body = Buffer.from(JSON.stringify(paid));
  const good = createHmac("sha256", "s3cret").update(body).digest("base64");
  assert.equal(verifyShopifySignature(body, good, "s3cret"), true);
  assert.equal(verifyShopifySignature(body, good, "other"), false);
  assert.equal(verifyShopifySignature(Buffer.from(body.toString().replace("419.85", "1.00")), good, "s3cret"), false);
  assert.equal(verifyShopifySignature(body, undefined, "s3cret"), false);
  assert.equal(verifyShopifySignature(body, "", "s3cret"), false);
  assert.equal(verifyShopifySignature(body, good, ""), false, "no secret configured: everything is rejected");
  assert.equal(verifyShopifySignature(body, createHmac("sha256", "s3cret").update(body).digest("hex"), "s3cret"), false);
});

test("order numbers come from the sequence: MM-YYMMDD-NNNNN", () => {
  const at = new Date("2026-10-09T10:00:00+02:00");
  assert.equal(orderNumber(42, at), "MM-261009-00042");
  assert.equal(orderNumber(123456, at), "MM-261009-123456");
  assert.notEqual(orderNumber(1, at), orderNumber(2, at));
  // Never equal to a legacy number (4 random digits).
  assert.match(orderNumber(1, at), /^MM-\d{6}-\d{5,}$/);
});
