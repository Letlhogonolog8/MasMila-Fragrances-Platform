/**
 * Payment integrity and checkout reliability, over HTTP against the real code
 * on a DISPOSABLE local database (TEST_PAYMENTS_DATABASE_URL, migrations
 * applied, may start empty — the demo network is seeded into it).
 *
 * Shopify is simulated: the Storefront API (cart creation) is answered by a
 * stub inside this process, and webhooks are synthetic payloads in the REST
 * Order shape, signed with a test secret. No real Shopify store, payment or
 * credential is involved.
 *
 * The app runs as if behind one trusted proxy (TRUSTED_PROXY_HOPS=1), which
 * appends each shopper's address to X-Forwarded-For; simultaneous shoppers get
 * distinct addresses so the checkout rate limiter (20 requests / 10 min per
 * client) treats them as the different people they represent.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabaseUrl } from "./helpers";

const url = testDatabaseUrl("TEST_PAYMENTS_DATABASE_URL");
const skip = url ? false : "TEST_PAYMENTS_DATABASE_URL not set";
const SECRET = "payments-test-secret";
const SHOP = "test-shop.myshopify.com";

for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "DISABLE_DEMO_AUTH", "ADMIN_EMAILS", "DEMO_AUTH", "SEED_DEMO_DATA", "SHOPIFY_ALLOW_TEST_ORDERS", "REPLIT_CONNECTORS_HOSTNAME"]) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
process.env.TRUSTED_PROXY_HOPS = "1";
process.env.SHOPIFY_STORE_DOMAIN = SHOP;
process.env.SHOPIFY_STOREFRONT_TOKEN = "fake-storefront-token";
if (url) process.env.DATABASE_URL = url;

// Storefront API stub: every cartCreate returns a new checkout URL, or fails while `shopifyDown`.
const realFetch = globalThis.fetch;
let cartsCreated = 0;
let shopifyDown = false;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (target.includes(SHOP)) {
    if (shopifyDown) return new Response("unavailable", { status: 503 });
    const n = ++cartsCreated;
    return Response.json({ data: { cartCreate: { cart: { id: `gid://shopify/Cart/${n}`, checkoutUrl: `https://${SHOP}/cart/c/${n}` }, userErrors: [] } } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const ADMIN = "admin@masmila.co.za";
const TEAM_LEADER = "teamleader@masmila.co.za";

let server: Server;
let base = "";
let D: typeof import("@workspace/db");
let referralCode = "";

type Call = { email?: string; body?: unknown; headers?: Record<string, string>; raw?: string };
async function call(method: string, path: string, o: Call = {}) {
  const response = await realFetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(o.email ? { authorization: `Bearer demo:${o.email}` } : {}), ...o.headers },
    body: o.raw ?? (method === "GET" ? undefined : JSON.stringify(o.body ?? {})),
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    /* empty */
  }
  return { status: response.status, body };
}

const sql = (text: string, params: unknown[] = []) => D.pool.query(text, params);
const one = async (text: string, params: unknown[] = []) => (await sql(text, params)).rows[0];
const count = async (text: string, params: unknown[] = []) => Number((await one(text, params)).n);

let seq = 0;
let shopper = 0;
const nextIp = () => `10.77.${Math.floor(++shopper / 250)}.${(shopper % 250) + 1}`;

async function makeProduct(stockQuantity: number) {
  const tag = randomUUID().slice(0, 8);
  const [p] = await D.db
    .insert(D.productsTable)
    .values({ slug: `pay-${tag}`, sku: `PAY-${tag}`, name: `Payment test ${++seq}`, category: "Unisex", family: "Fresh", size: "50ml", retailPrice: 299, recommendedRetailPrice: 299, resellerPrice: 140, cost: 50, stockQuantity, shopifyVariantId: `gid://shopify/ProductVariant/${880000 + seq}` })
    .returning();
  return p!;
}

type CheckoutOptions = { quantity?: number; key?: string; method?: "eft" | "shopify"; referral?: boolean; user?: string };
function checkout(productId: number, o: CheckoutOptions = {}) {
  const tag = randomUUID().slice(0, 8);
  return call("POST", "/checkout", {
    email: o.user,
    headers: { "x-forwarded-for": nextIp() },
    body: {
      mode: "retail",
      items: [{ productId, quantity: o.quantity ?? 1 }],
      customer: { firstName: "Pay", surname: "Tester", email: o.user ?? `buyer-${tag}@payments.test`, mobile: "0821234567" },
      address: { line1: "1 Payment Street", city: "Durban", province: "KwaZulu-Natal", postalCode: "4001" },
      paymentMethod: o.method ?? "shopify",
      ...(o.referral ? { referralCode, attributionSource: "code" } : {}),
      ...(o.key ? { idempotencyKey: o.key } : {}),
    },
  });
}

/** A placed (unpaid) order through the real checkout endpoint. */
async function placeOrder(productId: number, o: CheckoutOptions = {}) {
  const res = await checkout(productId, o);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order as { id: number; orderNumber: string; total: number; paymentMethod: string };
}

let shopifyIds = 9_100_000;
/** An orders/paid payload (REST Order shape) paying `order` in full, in rand. */
function paidPayload(order: { orderNumber: string; total: number }, over: Record<string, unknown> = {}) {
  const id = ++shopifyIds;
  const amount = order.total.toFixed(2);
  return {
    id,
    name: `#${id}`,
    financial_status: "paid",
    currency: "ZAR",
    presentment_currency: "ZAR",
    total_price: amount,
    total_price_set: { shop_money: { amount, currency_code: "ZAR" }, presentment_money: { amount, currency_code: "ZAR" } },
    total_outstanding: "0.00",
    test: false,
    cancelled_at: null,
    note_attributes: [{ name: "masmila_order", value: order.orderNumber }],
    ...over,
  };
}

/** A delivery as Shopify sends it: signed, with the store and API version headers (`shop: null` omits the store header). */
function hook(topic: string, payload: object, o: { secret?: string; deliveryId?: string; signature?: string | null; rawOverride?: string; shop?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const signature = o.signature === undefined ? createHmac("sha256", o.secret ?? SECRET).update(raw).digest("base64") : o.signature;
  return call("POST", "/webhooks/shopify", {
    raw: o.rawOverride ?? raw,
    headers: {
      "x-shopify-topic": topic,
      "x-shopify-webhook-id": o.deliveryId ?? randomUUID(),
      "x-shopify-api-version": "2026-10",
      ...(o.shop === null ? {} : { "x-shopify-shop-domain": o.shop ?? SHOP }),
      ...(signature != null ? { "x-shopify-hmac-sha256": signature } : {}),
    },
  });
}

const orderRow = (id: number) => one(`select * from orders where id = $1`, [id]);
const stockOf = async (productId: number) => {
  const r = await one(`select stock_quantity as s, reserved_quantity as r from products where id = $1`, [productId]);
  return { stock: Number(r.s), reserved: Number(r.r) };
};
const ledgerRows = (orderId: number) => count(`select count(*)::int as n from commission_ledger where order_id = $1`, [orderId]);
const eventsFor = (shopifyOrderId: number) => sql(`select * from payment_events where external_order_id = $1`, [String(shopifyOrderId)]).then((r) => r.rows);
const flags = (orderId: number, type: string) => count(`select count(*)::int as n from fraud_flags where order_id = $1 and type = $2`, [orderId, type]);

/** Asserts a payment was refused and quarantined without touching the order. */
async function assertQuarantined(order: { id: number }, productId: number, payload: { id: number }, reason: string, expectedStatus = "awaiting_payment") {
  const before = await stockOf(productId);
  const res = await hook("orders/paid", payload);
  assert.equal(res.status, 200, "a decision is acknowledged so Shopify does not retry it");
  assert.deepEqual([res.body.outcome, res.body.reason], ["rejected", reason]);
  const row = await orderRow(order.id);
  assert.equal(row.status, expectedStatus);
  assert.notEqual(row.shopify_order_id, String(payload.id));
  assert.deepEqual(await stockOf(productId), before, "stock unchanged");
  const [event] = await eventsFor(payload.id);
  assert.deepEqual([event.outcome, event.reason], ["rejected", reason], "stored in quarantine with the reason");
  assert.ok((await flags(order.id, "payment_rejected")) >= 1, "administrators alerted");
}

before(async () => {
  if (skip) return;
  D = await import("@workspace/db");
  const { prepareData } = await import("../lib/prepare");
  const { default: app } = await import("../app");
  await prepareData();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  referralCode = (await one(`select r.referral_code from resellers r join users u on u.id = r.user_id where u.email = $1`, [TEAM_LEADER])).referral_code;
});

after(async () => {
  if (skip) return;
  server?.close();
  await D?.pool.end();
});

// ================================================================ A. Shopify payment verification

test("A1. a valid signed payment settles the order once: status, stock, incentives, audit, event", { skip }, async () => {
  const product = await makeProduct(20);
  const order = await placeOrder(product.id, { quantity: 2, referral: true });
  assert.equal(order.paymentMethod, "shopify");
  const before = await stockOf(product.id);
  assert.equal(await ledgerRows(order.id), 0, "no incentives before payment");

  const payload = paidPayload(order);
  const res = await hook("orders/paid", payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, "applied");

  const row = await orderRow(order.id);
  assert.deepEqual([row.status, row.shopify_order_id, row.payment_reference], ["paid", String(payload.id), payload.name]);
  assert.deepEqual(await stockOf(product.id), { stock: before.stock - 2, reserved: before.reserved - 2 });
  assert.ok((await ledgerRows(order.id)) > 0, "referral incentives accrued with the verified payment");
  const [event] = await eventsFor(payload.id);
  assert.deepEqual([event.outcome, event.order_id, Number(event.amount), event.currency], ["applied", order.id, order.total, "ZAR"]);
  const audit = await one(`select metadata from audit_logs where action = 'order_paid' and entity_id = $1`, [order.orderNumber]);
  assert.equal(JSON.parse(audit.metadata).paymentEventId, event.id, "the audit row names the payment event");
});

test("A2. invalid signatures are rejected before anything is read or stored", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id);
  const payload = paidPayload(order);
  const raw = JSON.stringify(payload);
  const eventsBefore = await count(`select count(*)::int as n from payment_events`);

  assert.equal((await hook("orders/paid", payload, { secret: "wrong-secret" })).status, 401, "wrong secret");
  assert.equal((await hook("orders/paid", payload, { signature: null })).status, 401, "no signature");
  assert.equal((await hook("orders/paid", payload, { signature: "not-base64!!" })).status, 401, "garbage signature");
  assert.equal((await hook("orders/paid", payload, { signature: createHmac("sha256", SECRET).update(raw).digest("hex") })).status, 401, "hex instead of base64");
  // Signed, then the amount edited in transit.
  const tampered = raw.replaceAll(order.total.toFixed(2), "1.00");
  assert.equal((await hook("orders/paid", payload, { rawOverride: tampered })).status, 401, "body changed after signing");

  assert.equal((await orderRow(order.id)).status, "awaiting_payment");
  assert.equal(await count(`select count(*)::int as n from payment_events`), eventsBefore, "nothing recorded");
});

test("A3. correct order reference with an incorrect amount is quarantined (under- and overpayment)", { skip }, async () => {
  const product = await makeProduct(10);
  const order = await placeOrder(product.id, { referral: true });
  await assertQuarantined(order, product.id, paidPayload(order, { total_price: "1.00", total_price_set: { shop_money: { amount: "1.00", currency_code: "ZAR" } } }), "underpayment");
  const off = (order.total - 0.01).toFixed(2);
  await assertQuarantined(order, product.id, paidPayload(order, { total_price: off, total_price_set: { shop_money: { amount: off, currency_code: "ZAR" } } }), "underpayment");
  const over = (order.total + 50).toFixed(2);
  await assertQuarantined(order, product.id, paidPayload(order, { total_price: over, total_price_set: { shop_money: { amount: over, currency_code: "ZAR" } } }), "overpayment");
  assert.equal(await ledgerRows(order.id), 0, "no incentives from a rejected payment");

  // A later, exact payment still settles the order.
  assert.equal((await hook("orders/paid", paidPayload(order))).body.outcome, "applied");
  assert.equal((await orderRow(order.id)).status, "paid");
});

test("A4. correct amount in an incorrect currency is quarantined", { skip }, async () => {
  const product = await makeProduct(10);
  const order = await placeOrder(product.id, { referral: true });
  const amount = order.total.toFixed(2);
  await assertQuarantined(order, product.id, paidPayload(order, { currency: "USD", total_price_set: { shop_money: { amount, currency_code: "USD" } } }), "currency_mismatch");
  assert.equal(await ledgerRows(order.id), 0);
});

test("A5. duplicate and concurrent deliveries of one payment apply it exactly once", { skip }, async () => {
  const product = await makeProduct(20);

  // Shopify retry: the same delivery twice, one after the other.
  const first = await placeOrder(product.id, { referral: true });
  const payload = paidPayload(first);
  const deliveryId = randomUUID();
  assert.equal((await hook("orders/paid", payload, { deliveryId })).body.outcome, "applied");
  const afterFirst = { stock: await stockOf(product.id), ledger: await ledgerRows(first.id) };
  assert.equal((await hook("orders/paid", payload, { deliveryId })).body.outcome, "duplicate");
  assert.deepEqual(await stockOf(product.id), afterFirst.stock);
  assert.equal(await ledgerRows(first.id), afterFirst.ledger);

  // Eight simultaneous deliveries (retries and parallel subscriptions) of another payment.
  const second = await placeOrder(product.id, { quantity: 3, referral: true });
  const before = await stockOf(product.id);
  const payload2 = paidPayload(second);
  const results = await Promise.all(Array.from({ length: 8 }, () => hook("orders/paid", payload2)));
  assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
  const outcomes = results.map((r) => r.body.outcome).sort();
  assert.deepEqual(outcomes, ["applied", ...Array(7).fill("duplicate")]);
  assert.deepEqual(await stockOf(product.id), { stock: before.stock - 3, reserved: before.reserved - 3 }, "stock deducted once");
  assert.equal((await eventsFor(payload2.id)).length, 1);
  assert.equal(await count(`select count(*)::int as n from audit_logs where action = 'order_paid' and entity_id = $1`, [second.orderNumber]), 1);
  const accruals = await count(`select count(*)::int as n from commission_ledger where order_id = $1 and entry_type = 'accrual'`, [second.id]);
  assert.ok(accruals > 0);
  assert.equal(accruals, await count(`select count(distinct (order_item_id, beneficiary_reseller_id, kind))::int as n from commission_ledger where order_id = $1`, [second.id]), "no incentive accrued twice");
});

test("A6. already-paid, refunded, cancelled, partially paid, test, EFT and unknown orders", { skip }, async () => {
  const product = await makeProduct(40);

  // Already paid through Shopify: a second Shopify order paying it is a duplicate payment.
  const paidOrder = await placeOrder(product.id);
  const original = paidPayload(paidOrder);
  await hook("orders/paid", original);
  await assertQuarantined(paidOrder, product.id, paidPayload(paidOrder), "duplicate_payment", "paid");
  assert.equal((await orderRow(paidOrder.id)).shopify_order_id, String(original.id), "still linked to the payment that settled it");

  // Paid by EFT and confirmed by an administrator: a Shopify payment for it is a duplicate too.
  const eftPaid = await placeOrder(product.id, { method: "eft" });
  assert.equal((await call("PATCH", `/admin/orders/${eftPaid.id}`, { email: ADMIN, body: { status: "paid" } })).status, 200);
  await assertQuarantined(eftPaid, product.id, paidPayload(eftPaid), "duplicate_payment", "paid");

  // Refunded in full by an administrator, then a (new) Shopify payment arrives.
  const refunded = await placeOrder(product.id);
  await hook("orders/paid", paidPayload(refunded));
  assert.equal((await call("POST", `/admin/orders/${refunded.id}/refund`, { email: ADMIN, body: { type: "refund", reason: "customer request", idempotencyKey: randomUUID() } })).status, 200);
  await assertQuarantined(refunded, product.id, paidPayload(refunded), "order_refunded", "refunded");

  // Cancelled while unpaid (reservation released); the payment must not resurrect it.
  const cancelled = await placeOrder(product.id);
  assert.equal((await call("POST", `/admin/orders/${cancelled.id}/refund`, { email: ADMIN, body: { type: "cancel", reason: "abandoned", idempotencyKey: randomUUID() } })).status, 200);
  await assertQuarantined(cancelled, product.id, paidPayload(cancelled), "order_cancelled", "cancelled");
  assert.equal(await ledgerRows(cancelled.id), 0);

  // Partially paid: by Shopify's status, or by an outstanding balance.
  const partial = await placeOrder(product.id, { referral: true });
  await assertQuarantined(partial, product.id, paidPayload(partial, { financial_status: "partially_paid", total_outstanding: "100.00" }), "partial_payment");
  await assertQuarantined(partial, product.id, paidPayload(partial, { total_outstanding: "100.00" }), "partial_payment");
  await assertQuarantined(partial, product.id, paidPayload(partial, { financial_status: "pending" }), "not_paid");
  assert.equal(await ledgerRows(partial.id), 0, "no incentives from a partial payment");

  // A Shopify test order never settles a real order.
  const tested = await placeOrder(product.id);
  await assertQuarantined(tested, product.id, paidPayload(tested, { test: true }), "test_payment");

  // An EFT order did not create a Shopify checkout: a Shopify payment naming it is refused.
  const eft = await placeOrder(product.id, { method: "eft" });
  await assertQuarantined(eft, product.id, paidPayload(eft), "payment_method_mismatch");

  // No such order: recorded and raised, nothing else changes.
  const ghost = paidPayload({ orderNumber: "MM-000000-99999", total: 100 });
  const res = await hook("orders/paid", ghost);
  assert.deepEqual([res.status, res.body.outcome, res.body.reason], [200, "rejected", "unknown_order"]);
  const [event] = await eventsFor(ghost.id);
  assert.deepEqual([event.outcome, event.order_id], ["rejected", null]);
});

test("A7. processing interrupted mid-payment rolls back completely; Shopify's retry then succeeds", { skip }, async () => {
  const product = await makeProduct(10);
  const order = await placeOrder(product.id, { quantity: 2, referral: true });
  const before = await stockOf(product.id);
  const payload = paidPayload(order);
  const deliveryId = randomUUID();
  // Fail at the last write of the payment transaction (the audit row).
  await sql(`create or replace function payments_test_fail() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`);
  await sql(`create trigger payments_test_fail before insert on audit_logs for each row when (new.action = 'order_paid') execute function payments_test_fail()`);
  let failed;
  try {
    failed = await hook("orders/paid", payload, { deliveryId });
  } finally {
    await sql(`drop trigger if exists payments_test_fail on audit_logs`);
    await sql(`drop function if exists payments_test_fail()`);
  }
  assert.equal(failed.status, 500, "a failure is reported so Shopify retries");
  assert.equal((await orderRow(order.id)).status, "awaiting_payment");
  assert.deepEqual(await stockOf(product.id), before);
  assert.equal(await ledgerRows(order.id), 0);
  assert.equal((await eventsFor(payload.id)).length, 0, "not even the event record survives, so the retry is not mistaken for a duplicate");

  const retried = await hook("orders/paid", payload, { deliveryId });
  assert.equal(retried.body.outcome, "applied");
  assert.equal((await orderRow(order.id)).status, "paid");
  assert.deepEqual(await stockOf(product.id), { stock: before.stock - 2, reserved: before.reserved - 2 });
});

test("A8. Shopify cannot cancel or refund an order its own payment did not settle", { skip }, async () => {
  const product = await makeProduct(10);
  const order = await placeOrder(product.id, { method: "eft" });
  assert.equal((await call("PATCH", `/admin/orders/${order.id}`, { email: ADMIN, body: { status: "paid" } })).status, 200);
  const before = await stockOf(product.id);
  const res = await hook("orders/cancelled", { id: 7_000_001, note_attributes: [{ name: "masmila_order", value: order.orderNumber }] });
  assert.deepEqual([res.status, res.body.outcome], [200, "rejected"]);
  assert.equal((await orderRow(order.id)).status, "paid");
  assert.equal(await count(`select count(*)::int as n from refunds where order_id = $1`, [order.id]), 0);
  assert.deepEqual(await stockOf(product.id), before);
  assert.equal(await flags(order.id, "webhook_rejected"), 1);

  // An unpaid Shopify checkout cancelled in Shopify is still released.
  const pending = await placeOrder(product.id);
  const reserved = (await stockOf(product.id)).reserved;
  const cancel = await hook("orders/cancelled", { id: 7_000_002, note_attributes: [{ name: "masmila_order", value: pending.orderNumber }] });
  assert.deepEqual([cancel.status, cancel.body.outcome], [200, "applied"]);
  assert.equal((await orderRow(pending.id)).status, "cancelled");
  assert.equal((await stockOf(product.id)).reserved, reserved - 1);
});

// ================================================================ B. Checkout and order numbers

test("B1. simultaneous checkouts never oversell and never leave partial orders", { skip }, async () => {
  const product = await makeProduct(10);
  const results = await Promise.all(Array.from({ length: 30 }, () => checkout(product.id, { method: "eft" })));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 10, "exactly the stock on hand was sold");
  assert.equal(statuses.filter((s) => s === 409).length, 20, "the rest were told it sold out");
  assert.equal(statuses.filter((s) => s >= 500).length, 0, "no server errors");
  assert.deepEqual(await stockOf(product.id), { stock: 10, reserved: 10 });
  assert.equal(await count(`select count(distinct order_id)::int as n from order_items where product_id = $1`, [product.id]), 10);
  assert.equal(await count(`select count(*)::int as n from orders o where not exists (select 1 from order_items i where i.order_id = o.id)`), 0, "no order without lines");
});

test("B2. order numbers stay unique under concurrent checkouts (no collision, no retry, no 500)", { skip }, async () => {
  const product = await makeProduct(1000);
  const results = await Promise.all(Array.from({ length: 50 }, () => checkout(product.id, { method: "eft" })));
  assert.deepEqual([...new Set(results.map((r) => r.status))], [201], JSON.stringify(results.find((r) => r.status !== 201)?.body));
  const numbers = results.map((r) => r.body.order.orderNumber as string);
  assert.equal(new Set(numbers).size, 50);
  for (const n of numbers) assert.match(n, /^MM-\d{6}-\d{5,}$/);
  assert.equal(await count(`select count(*)::int as n from (select order_number from orders group by order_number having count(*) > 1) d`), 0);
});

test("B3. a retried or double-submitted checkout returns the same order instead of a second one", { skip }, async () => {
  const product = await makeProduct(50);
  const key = randomUUID();
  const first = await checkout(product.id, { key, quantity: 2, method: "eft" });
  assert.equal(first.status, 201);
  const reserved = (await stockOf(product.id)).reserved;
  const again = await checkout(product.id, { key, quantity: 2, method: "eft" });
  assert.equal(again.status, 200);
  assert.equal(again.body.order.id, first.body.order.id);
  assert.equal(again.body.paymentInstructions, first.body.paymentInstructions);
  assert.equal((await stockOf(product.id)).reserved, reserved, "stock reserved once");

  // Six simultaneous submissions with one key: one order.
  const key2 = randomUUID();
  const burst = await Promise.all(Array.from({ length: 6 }, () => checkout(product.id, { key: key2, method: "eft" })));
  assert.deepEqual(burst.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
  assert.equal(new Set(burst.map((r) => r.body.order.id)).size, 1);
  assert.equal(await count(`select count(*)::int as n from orders where checkout_key = $1`, [key2]), 1);
  assert.equal((await stockOf(product.id)).reserved, reserved + 1);
});

test("B4. one Shopify checkout per order: retries get the same payment link, never a second cart", { skip }, async () => {
  const product = await makeProduct(10);
  const key = randomUUID();
  const carts = cartsCreated;
  const first = await checkout(product.id, { key });
  assert.equal(first.status, 201);
  assert.match(first.body.checkoutUrl, new RegExp(`^https://${SHOP}/cart/c/`));
  const again = await checkout(product.id, { key });
  assert.deepEqual([again.status, again.body.checkoutUrl], [200, first.body.checkoutUrl]);
  assert.equal(cartsCreated - carts, 1, "the customer can only ever be sent to one Shopify checkout");

  // Shopify unavailable: the order falls back to EFT (no Shopify payment can then settle it).
  shopifyDown = true;
  try {
    const fallback = await checkout(product.id);
    assert.equal(fallback.status, 201);
    assert.deepEqual([fallback.body.checkoutUrl, fallback.body.order.paymentMethod], [null, "eft"]);
    assert.match(fallback.body.paymentInstructions, /EFT/);
  } finally {
    shopifyDown = false;
  }
});

test("B5. a checkout key cannot be replayed from another account", { skip }, async () => {
  const product = await makeProduct(10);
  const key = randomUUID();
  assert.equal((await checkout(product.id, { key, method: "eft" })).status, 201);
  const other = await checkout(product.id, { key, method: "eft", user: "customer@masmila.co.za" });
  assert.equal(other.status, 409);
  assert.equal(await count(`select count(*)::int as n from orders where checkout_key = $1`, [key]), 1);
});

test("B6. a failed checkout leaves nothing behind and the same key can be retried", { skip }, async () => {
  const product = await makeProduct(0);
  const key = randomUUID();
  const ordersBefore = await count(`select count(*)::int as n from orders`);
  const soldOut = await checkout(product.id, { key, method: "eft" });
  assert.equal(soldOut.status, 409);
  assert.equal(await count(`select count(*)::int as n from orders`), ordersBefore);
  await sql(`update products set stock_quantity = 5 where id = $1`, [product.id]);
  const retry = await checkout(product.id, { key, method: "eft" });
  assert.equal(retry.status, 201, "the failed attempt did not consume the key");
});

test("B7. stock stays consistent when simultaneous checkouts are paid simultaneously", { skip }, async () => {
  const product = await makeProduct(6);
  const placed = await Promise.all(Array.from({ length: 9 }, () => checkout(product.id)));
  const created = placed.filter((r) => r.status === 201).map((r) => r.body.order);
  assert.equal(created.length, 6);
  assert.deepEqual(await stockOf(product.id), { stock: 6, reserved: 6 });
  // Every payment delivered twice, all at once.
  const payloads = created.map((o: { orderNumber: string; total: number }) => paidPayload(o));
  const deliveries = await Promise.all(payloads.flatMap((p: object) => [hook("orders/paid", p), hook("orders/paid", p)]));
  assert.deepEqual([...new Set(deliveries.map((d) => d.status))], [200]);
  assert.equal(deliveries.filter((d) => d.body.outcome === "applied").length, 6);
  assert.deepEqual(await stockOf(product.id), { stock: 0, reserved: 0 });
  for (const o of created) assert.equal((await orderRow(o.id)).status, "paid");
});

test("A9. only deliveries from this deployment's store are accepted; provenance is recorded", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id);
  const payload = paidPayload(order);
  // Correctly signed, but sent by another store (e.g. the live store calling the staging URL), or without a store header.
  assert.equal((await hook("orders/paid", payload, { shop: "masmila-live.myshopify.com" })).status, 401);
  assert.equal((await hook("orders/paid", payload, { shop: null })).status, 401);
  assert.equal((await eventsFor(payload.id)).length, 0, "nothing recorded");
  assert.equal((await orderRow(order.id)).status, "awaiting_payment");
  // The genuine store (header case and scheme do not matter).
  const ok = await hook("orders/paid", payload, { shop: SHOP.toUpperCase() });
  assert.equal(ok.body.outcome, "applied");
  const [event] = await eventsFor(payload.id);
  assert.deepEqual([event.shop_domain, event.api_version, event.test_payment], [SHOP, "2026-10", false]);
  const { provenance } = await import("../lib/staging-evidence");
  assert.equal(provenance(event), `shopify:${SHOP}`);
});
