/**
 * Financial integrity: refunds, commission reversals, payouts and their
 * idempotency, exercised over HTTP and against the real database code on a
 * DISPOSABLE local database (TEST_FINANCE_DATABASE_URL, schema applied, may
 * start empty — the demo network is seeded into it). Tests run in order and
 * build on each other's data; each scenario uses its own new reseller, so
 * the amounts below are exact.
 *
 * Network used (from the demo seed): Manager Thandi → Team Leader Nomdade →
 * scenario resellers. A scenario reseller's stock order pays Nomdade 5% (Team
 * Leader) and Thandi 2% (Manager) of its wholesale value.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabaseUrl } from "./helpers";

const url = testDatabaseUrl("TEST_FINANCE_DATABASE_URL");
const skip = url ? false : "TEST_FINANCE_DATABASE_URL not set";

for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "DISABLE_DEMO_AUTH", "ADMIN_EMAILS", "DEMO_AUTH", "SEED_DEMO_DATA"]) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SHOPIFY_WEBHOOK_SECRET = "finance-test-secret";
if (url) process.env.DATABASE_URL = url;

const ADMIN = "admin@masmila.co.za";
const MANAGER = "manager@masmila.co.za";
const TEAM_LEADER = "teamleader@masmila.co.za";
const CUSTOMER = "customer@masmila.co.za";

let server: Server;
let base = "";
let D: typeof import("@workspace/db");
let O: typeof import("drizzle-orm");
let orders: typeof import("../lib/orders");
let network: typeof import("../lib/network");
let period = "";
let nomdade: { id: number; userId: number };
let thandi: { id: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
let seq = 0;

type Call = { email?: string; body?: unknown; headers?: Record<string, string>; raw?: string };
async function call(method: string, path: string, o: Call = {}) {
  const response = await fetch(base + path, {
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

async function makeProduct(resellerPrice: number, extra: { shopifyVariantId?: string } = {}) {
  const n = ++seq;
  const [p] = await D.db
    .insert(D.productsTable)
    .values({ slug: `fin-${n}-${randomUUID().slice(0, 6)}`, sku: `FIN-${n}-${randomUUID().slice(0, 6)}`, name: `Finance test ${n}`, category: "Unisex", family: "Fresh", size: "50ml", retailPrice: 299, recommendedRetailPrice: 299, resellerPrice, cost: 50, stockQuantity: 1000, ...extra })
    .returning();
  return p!;
}

/** A new reseller in Nomdade's team who has completed their opening order. */
async function makeSeller() {
  const n = ++seq;
  const tag = randomUUID().slice(0, 8);
  const [user] = await D.db.insert(D.usersTable).values({ email: `seller-${tag}@finance.test`, role: "reseller", firstName: `Seller${n}`, surname: "Test", mobile: `08${String(30000000 + n)}` }).returning();
  const [reseller] = await D.db
    .insert(D.resellersTable)
    .values({ userId: user!.id, resellerCode: `FIN-${tag}`, referralCode: `FIN${tag.toUpperCase()}`, sponsorId: nomdade.id, openingOrderCompleted: true, status: "active" })
    .returning();
  return { user: user!, reseller: reseller! };
}

/** Paid wholesale order: returns the order and its lines. */
async function paidOrder(seller: Awaited<ReturnType<typeof makeSeller>>, lines: Array<{ productId: number; quantity: number }>, paid: { shopifyOrderId?: string } = {}) {
  const { orderId } = await orders.createOrder(
    {
      mode: "reseller",
      items: lines,
      customer: { firstName: seller.user.firstName, surname: "Test", email: seller.user.email, mobile: seller.user.mobile! },
      address: { line1: "1 Ledger Lane", city: "Pretoria", province: "Gauteng", postalCode: "0083" },
      paymentMethod: "eft",
    },
    { user: seller.user, reseller: seller.reseller },
  );
  await orders.markOrderPaid(orderId, "test", paid);
  const items = await D.db.select().from(D.orderItemsTable).where(O.eq(D.orderItemsTable.orderId, orderId)).orderBy(D.orderItemsTable.id);
  return { orderId, items };
}

/** Net incentive (accrual + reversals, live rows only) for one order line, beneficiary and kind. */
async function net(orderItemId: number, beneficiaryId: number, kind: string) {
  const row = await one(
    `select coalesce(sum(amount), 0)::numeric as net from commission_ledger
     where order_item_id = $1 and beneficiary_reseller_id = $2 and kind = $3 and status in ('pending', 'approved', 'paid')`,
    [orderItemId, beneficiaryId, kind],
  );
  return Number(row.net);
}

const accrualOf = async (orderItemId: number, beneficiaryId: number, kind: string) =>
  one(`select * from commission_ledger where entry_type = 'accrual' and order_item_id = $1 and beneficiary_reseller_id = $2 and kind = $3 and status <> 'void'`, [orderItemId, beneficiaryId, kind]);

const refundVia = (orderId: number, body: Record<string, unknown>, email = ADMIN) => call("POST", `/admin/orders/${orderId}/refund`, { email, body: { reason: "test refund", ...body } });

const settle = () => network.runQualification(period, null);

function shopifyHook(topic: string, payload: object) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", "finance-test-secret").update(raw).digest("base64");
  return call("POST", "/webhooks/shopify", { raw, headers: { "x-shopify-topic": topic, "x-shopify-hmac-sha256": signature } });
}

before(async () => {
  if (skip) return;
  D = await import("@workspace/db");
  O = await import("drizzle-orm");
  orders = await import("../lib/orders");
  network = await import("../lib/network");
  const { prepareData } = await import("../lib/prepare");
  const { currentPeriod } = await import("../lib/period");
  const { default: app } = await import("../app");
  await prepareData();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  period = currentPeriod();
  nomdade = await one(`select r.id, r.user_id as "userId" from resellers r join users u on u.id = r.user_id where u.email = $1`, [TEAM_LEADER]);
  thandi = await one(`select r.id from resellers r join users u on u.id = r.user_id where u.email = $1`, [MANAGER]);
  // Seeded orders may be from an earlier month if the database was reused; settle the period of this run.
});

after(async () => {
  if (skip) return;
  server?.close();
  await D?.pool.end();
});

// ---------------------------------------------------------------- 12. rules unchanged
test("12. qualification and commission rules unchanged: the proposal's acceptance amounts", { skip }, async () => {
  const seededPeriod = (await one(`select period from orders where channel = 'reseller' and period is not null order by id limit 1`)).period as string;
  await network.runQualification(seededPeriod, null);
  // Only the seeded demo orders (placed by the seeded network), never later test orders.
  const seeded = `order_id in (select o.id from orders o join resellers r on r.id = o.reseller_id join users u on u.id = r.user_id where u.email like '%@masmila.co.za' and o.period = $1)`;
  const total = async (beneficiary: number, kind: string) =>
    Number((await one(`select coalesce(sum(amount),0) as t from commission_ledger where ${seeded} and beneficiary_reseller_id = $2 and kind = $3 and entry_type = 'accrual' and status <> 'void'`, [seededPeriod, beneficiary, kind])).t);
  assert.equal(await total(nomdade.id, "team_leader"), 700, "TL: 5% × 100 team bottles × R140");
  assert.equal(await total(thandi.id, "manager"), 1008, "Manager: 2% × 360 bottles × R140 across three TL teams");
  assert.equal(await total(thandi.id, "team_leader"), 420, "Manager as direct sponsor: 5% × 60 TL bottles × R140");
  const tl = await one(`select qualified_rank, is_active from qualification_periods where reseller_id = $1 and period = $2`, [nomdade.id, seededPeriod]);
  assert.deepEqual([tl.qualified_rank, tl.is_active], ["team_leader", true]);
  const mgr = await one(`select qualified_rank from qualification_periods where reseller_id = $1 and period = $2`, [thandi.id, seededPeriod]);
  assert.equal(mgr.qualified_rank, "manager");
  if (seededPeriod !== period) await settle();
});

// ---------------------------------------------------------------- 1. single partial refund
test("1. single partial refund: 2 of 5 bottles reverses exactly 2/5, before and after month-end settlement", { skip }, async () => {
  const product = await makeProduct(140);
  const seller = await makeSeller();
  const { orderId, items } = await paidOrder(seller, [{ productId: product.id, quantity: 5 }]);
  const line = items[0]!;
  // 5 × R140 = R700 wholesale → TL 5% = R35.00, Manager 2% = R14.00
  assert.equal(Number((await accrualOf(line.id, nomdade.id, "team_leader")).amount), 35);
  assert.equal(Number((await accrualOf(line.id, thandi.id, "manager")).amount), 14);

  const res = await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 2 }], idempotencyKey: randomUUID() });
  assert.equal(res.status, 200);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 21); // 35 − 14
  assert.equal(await net(line.id, thandi.id, "manager"), 8.4); // 14 − 5.60

  await settle(); // the month-end run used to shrink the accrual AND keep the reversal (R7 / R2.80)
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 21);
  assert.equal(await net(line.id, thandi.id, "manager"), 8.4);
  const accrual = await accrualOf(line.id, nomdade.id, "team_leader");
  assert.deepEqual([Number(accrual.amount), accrual.quantity, accrual.qualification_status], [35, 5, "qualified"], "accrual never resized");
  const reversal = await one(`select * from commission_ledger where reversal_of_id = $1`, [accrual.id]);
  assert.equal(Number(reversal.amount), -14);
  assert.equal(reversal.quantity, -2);
  assert.ok(reversal.refund_id, "reversal is linked to its refund");
  const refund = await one(`select * from refunds where id = $1`, [reversal.refund_id]);
  assert.deepEqual([refund.order_id, refund.type, Number(refund.amount), refund.order_was_paid], [orderId, "refund", r2(2 * line.unitPrice), true]);
  assert.equal((await one(`select status from orders where id = $1`, [orderId])).status, "partially_refunded");
});

// ---------------------------------------------------------------- 2. multiple partial refunds
test("2. multiple partial refunds: 1 then 2 of 5 bottles", { skip }, async () => {
  const product = await makeProduct(140);
  const seller = await makeSeller();
  const { orderId, items } = await paidOrder(seller, [{ productId: product.id, quantity: 5 }]);
  const line = items[0]!;
  assert.equal((await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 1 }] })).status, 200);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 28); // 35 − 7
  assert.equal((await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 2 }] })).status, 200);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 14); // 35 − 7 − 14
  assert.equal(await net(line.id, thandi.id, "manager"), 5.6); // 14 − 2.80 − 5.60
  await settle();
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 14);
  assert.equal(await net(line.id, thandi.id, "manager"), 5.6);
  assert.equal((await one(`select count(*)::int as n from refunds where order_id = $1`, [orderId])).n, 2);
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 3);
});

// ---------------------------------------------------------------- 3. partial refunds then full refund
test("3. two partial refunds then a full refund net exactly zero — reversals never exceed the original", { skip }, async () => {
  // 3 × R139.95 = R419.85 → TL 5% = R20.99 (rounded), so three proportional thirds (R7.00 each = R21.00)
  // would reverse MORE than was earned; the final refund reverses only the R6.99 remainder.
  const product = await makeProduct(139.95);
  const seller = await makeSeller();
  const { orderId, items } = await paidOrder(seller, [{ productId: product.id, quantity: 3 }]);
  const line = items[0]!;
  const tl = await accrualOf(line.id, nomdade.id, "team_leader");
  assert.equal(Number(tl.amount), 20.99);
  await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 1 }] });
  await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 1 }] });
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 6.99);
  assert.equal((await refundVia(orderId, { type: "refund" })).status, 200); // everything left
  const amounts = (await sql(`select amount from commission_ledger where reversal_of_id = $1 order by id`, [tl.id])).rows.map((r) => Number(r.amount));
  assert.deepEqual(amounts, [-7, -7, -6.99]);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 0);
  assert.equal(await net(line.id, thandi.id, "manager"), 0); // 8.40 − 2.80 × 3
  assert.equal((await one(`select status from orders where id = $1`, [orderId])).status, "refunded");
  // Nothing left: a further refund changes nothing.
  assert.equal((await refundVia(orderId, { type: "refund" })).status, 400);
  await settle();
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 0);
  assert.equal((await one(`select count(*)::int as n from commission_ledger where reversal_of_id = $1`, [tl.id])).n, 3);
});

// ---------------------------------------------------------------- 4. duplicate delivery
test("4. duplicate delivery of the same refund event is applied once (Shopify webhook and admin retry)", { skip }, async () => {
  const product = await makeProduct(140, { shopifyVariantId: `gid://shopify/ProductVariant/${9000 + ++seq}` });
  const variant = Number(product.shopifyVariantId!.split("/").pop());
  const seller = await makeSeller();
  const shopifyOrderId = `SO-${randomUUID().slice(0, 8)}`;
  const { orderId, items } = await paidOrder(seller, [{ productId: product.id, quantity: 4 }], { shopifyOrderId });
  const line = items[0]!;
  const event = { id: 700000 + seq, order_id: shopifyOrderId, refund_line_items: [{ quantity: 1, line_item: { variant_id: variant } }] };
  assert.equal((await shopifyHook("refunds/create", event)).status, 200);
  assert.equal((await shopifyHook("refunds/create", event)).status, 200); // Shopify retry
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 1);
  assert.equal((await one(`select count(*)::int as n from refunds where order_id = $1`, [orderId])).n, 1);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 21); // 28 − 7, once

  // Admin: the same idempotency key twice (double-click / retry after a lost response).
  const key = randomUUID();
  assert.equal((await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 1 }], idempotencyKey: key })).status, 200);
  assert.equal((await refundVia(orderId, { type: "refund", items: [{ orderItemId: line.id, quantity: 1 }], idempotencyKey: key })).status, 200);
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 2);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 14);
  // Reusing a key on another order is refused.
  const other = await paidOrder(seller, [{ productId: product.id, quantity: 1 }]);
  assert.equal((await refundVia(other.orderId, { type: "refund", idempotencyKey: key })).status, 409);
});

// ---------------------------------------------------------------- 5. concurrent processing
test("5. concurrent processing of the same refund applies it once", { skip }, async () => {
  const product = await makeProduct(140, { shopifyVariantId: `gid://shopify/ProductVariant/${9000 + ++seq}` });
  const variant = Number(product.shopifyVariantId!.split("/").pop());
  const seller = await makeSeller();
  const shopifyOrderId = `SO-${randomUUID().slice(0, 8)}`;
  const { orderId, items } = await paidOrder(seller, [{ productId: product.id, quantity: 6 }], { shopifyOrderId });
  const line = items[0]!;
  const event = { id: 800000 + seq, order_id: shopifyOrderId, refund_line_items: [{ quantity: 2, line_item: { variant_id: variant } }] };
  const deliveries = await Promise.all([1, 2, 3].map(() => shopifyHook("refunds/create", event)));
  assert.deepEqual(deliveries.map((d) => d.status), [200, 200, 200]);
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 2);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 28); // 42 − 14

  const key = randomUUID();
  const sameKey = await Promise.all([1, 2].map(() => refundVia(orderId, { type: "return", items: [{ orderItemId: line.id, quantity: 1 }], idempotencyKey: key })));
  assert.deepEqual(sameKey.map((d) => d.status), [200, 200]);
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 3);

  // Two "return everything" clicks without a key: the second finds nothing left.
  const stockBefore = (await one(`select stock_quantity from products where id = $1`, [product.id])).stock_quantity;
  const both = await Promise.all([1, 2].map(() => refundVia(orderId, { type: "return" })));
  assert.deepEqual(both.map((d) => d.status).sort(), [200, 400]);
  const stockAfter = (await one(`select stock_quantity from products where id = $1`, [product.id])).stock_quantity;
  assert.equal(stockAfter - stockBefore, 3, "the remaining 3 bottles restocked once");
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 0);
});

// ---------------------------------------------------------------- 9. refunds/cancellations: commission + stock together
test("9. returns, cancellations and chargebacks move commission and stock together", { skip }, async () => {
  const product = await makeProduct(140);
  const seller = await makeSeller();
  const stock = async () => (await one(`select stock_quantity as s, reserved_quantity as r from products where id = $1`, [product.id]));

  // Paid order of 4: return 2 (restock), then cancel the rest (restock), commission to zero.
  const a = await paidOrder(seller, [{ productId: product.id, quantity: 4 }]);
  const s0 = await stock();
  await refundVia(a.orderId, { type: "return", items: [{ orderItemId: a.items[0]!.id, quantity: 2 }] });
  assert.equal((await stock()).s - s0.s, 2);
  assert.equal(await net(a.items[0]!.id, nomdade.id, "team_leader"), 14);
  await refundVia(a.orderId, { type: "cancel" });
  assert.equal((await stock()).s - s0.s, 4);
  assert.equal(await net(a.items[0]!.id, nomdade.id, "team_leader"), 0);
  assert.equal((await one(`select status from orders where id = $1`, [a.orderId])).status, "cancelled");

  // Chargeback: commission reversed, stock untouched.
  const b = await paidOrder(seller, [{ productId: product.id, quantity: 2 }]);
  const s1 = await stock();
  await refundVia(b.orderId, { type: "chargeback" });
  assert.equal((await stock()).s, s1.s);
  assert.equal(await net(b.items[0]!.id, nomdade.id, "team_leader"), 0);

  // Unpaid order cancelled: reservation released, recorded, no incentives anywhere.
  const { orderId } = await orders.createOrder(
    { mode: "reseller", items: [{ productId: product.id, quantity: 3 }], customer: { firstName: "A", surname: "B", email: seller.user.email, mobile: seller.user.mobile! }, address: { line1: "1 Road", city: "Pretoria", province: "Gauteng", postalCode: "0083" }, paymentMethod: "eft" },
    { user: seller.user, reseller: seller.reseller },
  );
  assert.equal((await stock()).r - s1.r, 3);
  assert.equal((await refundVia(orderId, { type: "cancel" })).status, 200);
  assert.equal((await stock()).r, s1.r);
  const unpaid = await one(`select * from refunds where order_id = $1`, [orderId]);
  assert.deepEqual([unpaid.order_was_paid, Number(unpaid.amount)], [false, 0]);
  assert.equal((await one(`select count(*)::int as n from commission_ledger where order_id = $1`, [orderId])).n, 0);

  // Shopify "orders/cancelled" for an order already fully refunded: acknowledged, nothing changes.
  const c = await paidOrder(seller, [{ productId: product.id, quantity: 1 }], { shopifyOrderId: `SO-${randomUUID().slice(0, 8)}` });
  await refundVia(c.orderId, { type: "refund" });
  const shopifyId = (await one(`select shopify_order_id from orders where id = $1`, [c.orderId])).shopify_order_id;
  const before = (await one(`select count(*)::int as n from refunds where order_id = $1`, [c.orderId])).n;
  const hook = await shopifyHook("orders/cancelled", { id: shopifyId });
  assert.equal(hook.status, 200);
  assert.equal(hook.body.ignored, true);
  assert.equal((await one(`select count(*)::int as n from refunds where order_id = $1`, [c.orderId])).n, before);
});

// ---------------------------------------------------------------- 8a. failure + retry (refund)
test("8a. a refund that fails mid-transaction leaves nothing behind and can be retried safely", { skip }, async () => {
  const product = await makeProduct(140);
  const seller = await makeSeller();
  const { orderId, items } = await paidOrder(seller, [{ productId: product.id, quantity: 5 }]);
  const line = items[0]!;
  const stockBefore = (await one(`select stock_quantity from products where id = $1`, [product.id])).stock_quantity;
  await sql(`create or replace function finance_test_fail() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`);
  await sql(`create trigger finance_test_fail before insert on commission_ledger for each row when (new.entry_type = 'reversal') execute function finance_test_fail()`);
  const key = randomUUID();
  let failed;
  try {
    failed = await refundVia(orderId, { type: "return", items: [{ orderItemId: line.id, quantity: 2 }], idempotencyKey: key });
  } finally {
    await sql(`drop trigger if exists finance_test_fail on commission_ledger`);
  }
  assert.equal(failed.status, 500);
  // Rolled back: no refund record, quantities, stock, reversals, status or audit row.
  assert.equal((await one(`select count(*)::int as n from refunds where order_id = $1`, [orderId])).n, 0);
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 0);
  assert.equal((await one(`select stock_quantity from products where id = $1`, [product.id])).stock_quantity, stockBefore);
  assert.equal((await one(`select count(*)::int as n from commission_ledger where order_id = $1 and entry_type = 'reversal'`, [orderId])).n, 0);
  assert.equal((await one(`select status from orders where id = $1`, [orderId])).status, "paid");
  // Retry with the same key: applied once; a further retry is a no-op.
  assert.equal((await refundVia(orderId, { type: "return", items: [{ orderItemId: line.id, quantity: 2 }], idempotencyKey: key })).status, 200);
  assert.equal((await refundVia(orderId, { type: "return", items: [{ orderItemId: line.id, quantity: 2 }], idempotencyKey: key })).status, 200);
  assert.equal((await one(`select refunded_quantity from order_items where id = $1`, [line.id])).refunded_quantity, 2);
  assert.equal((await one(`select stock_quantity from products where id = $1`, [product.id])).stock_quantity, stockBefore + 2);
  assert.equal(await net(line.id, nomdade.id, "team_leader"), 21);
});

// ---------------------------------------------------------------- 6 / 7 / 8b. payouts
let payoutId = 0;

async function approveAllFor(beneficiaryId: number) {
  const ids = (await sql(`select id from commission_ledger where beneficiary_reseller_id = $1 and status = 'pending' and entry_type = 'accrual' and qualification_status = 'qualified'`, [beneficiaryId])).rows.map((r) => r.id);
  const res = await call("POST", "/admin/commissions/approve", { email: ADMIN, body: { ids } });
  assert.equal(res.status, 200);
}

/** Independently: what a reseller is owed = every approved, unallocated row of this period or earlier. */
async function payableFor(beneficiaryId: number) {
  return Number((await one(`select coalesce(sum(amount),0) as t from commission_ledger where beneficiary_reseller_id = $1 and status = 'approved' and payout_id is null and period <= $2`, [beneficiaryId, period])).t);
}

test("6. two simultaneous payout calculations create one payout for exactly the payable balance", { skip }, async () => {
  await settle();
  await approveAllFor(nomdade.id);
  // Approving accruals also approved their pending reversals, so the payable balance is net of refunds.
  assert.equal((await one(`select count(*)::int as n from commission_ledger r join commission_ledger a on a.id = r.reversal_of_id where r.beneficiary_reseller_id = $1 and r.status = 'pending' and a.status = 'approved'`, [nomdade.id])).n, 0);
  const expected = await payableFor(nomdade.id);
  assert.ok(expected > 0);
  const [a, b] = await Promise.all([1, 2].map(() => call("POST", "/admin/payouts", { email: ADMIN, body: { period, resellerIds: [nomdade.id] } })));
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(a.body.length + b.body.length, 1, "exactly one request created the payout");
  const payouts = (await sql(`select * from payouts where reseller_id = $1 and period = $2`, [nomdade.id, period])).rows;
  assert.equal(payouts.length, 1);
  payoutId = payouts[0].id;
  assert.equal(payouts[0].status, "pending");
  assert.equal(Number(payouts[0].amount), r2(expected));
  const allocated = await one(`select count(*)::int as n, coalesce(sum(amount),0) as t from commission_ledger where payout_id = $1`, [payoutId]);
  assert.equal(Number(allocated.t), Number(payouts[0].amount));
  assert.equal(allocated.n, payouts[0].entry_count);
  assert.equal(await payableFor(nomdade.id), 0, "nothing left unallocated");
});

test("7. repeated payout calculation for the same reseller and period creates nothing; the database refuses a duplicate", { skip }, async () => {
  const again = await call("POST", "/admin/payouts", { email: ADMIN, body: { period, resellerIds: [nomdade.id] } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, []);
  await assert.rejects(
    sql(`insert into payouts (payout_number, reseller_id, period, amount, entry_count, status) values ('PO-DUP', $1, $2, 1, 1, 'pending')`, [nomdade.id, period]),
    /payouts_reseller_period_uq/,
  );
  // Failing a payout releases its rows; recalculating creates a new payout for the same amount.
  const amount = Number((await one(`select amount from payouts where id = $1`, [payoutId])).amount);
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "failed" } })).status, 400, "a reason is required");
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "failed", failureReason: "Bank rejected account number" } })).status, 200);
  assert.equal((await one(`select count(*)::int as n from commission_ledger where payout_id = $1`, [payoutId])).n, 0);
  assert.equal(await payableFor(nomdade.id), amount);
  const recreated = await call("POST", "/admin/payouts", { email: ADMIN, body: { period, resellerIds: [nomdade.id] } });
  assert.equal(recreated.body.length, 1);
  assert.equal(recreated.body[0].amount, amount);
  assert.match(recreated.body[0].payoutNumber, /-2$/);
  payoutId = recreated.body[0].id;
  // Lifecycle: pending → approved → processing → paid; repeating a step is a no-op, skipping or reversing is refused.
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "paid" } })).status, 409);
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "approved" } })).status, 200);
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "approved" } })).status, 200);
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "processing", reference: "EFT-BATCH-1" } })).status, 200);
});

test("8b. a payout settlement that fails mid-transaction changes nothing and can be retried", { skip }, async () => {
  await sql(`create or replace function finance_test_fail() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`);
  await sql(`create trigger finance_test_fail before update on commission_ledger for each row when (new.status = 'paid' and old.status <> 'paid') execute function finance_test_fail()`);
  let failed;
  try {
    failed = await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "paid" } });
  } finally {
    await sql(`drop trigger if exists finance_test_fail on commission_ledger`);
  }
  assert.equal(failed.status, 500);
  assert.equal((await one(`select status from payouts where id = $1`, [payoutId])).status, "processing");
  assert.equal((await one(`select count(*)::int as n from commission_ledger where payout_id = $1 and status = 'paid'`, [payoutId])).n, 0);
  const paid = await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "paid" } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, "paid");
  assert.equal(paid.body.reference, "EFT-BATCH-1");
  const p = await one(`select * from payouts where id = $1`, [payoutId]);
  const admin = await one(`select id from users where email = $1`, [ADMIN]);
  assert.deepEqual([p.created_by, p.approved_by, p.processing_by, p.paid_by], [admin.id, admin.id, admin.id, admin.id], "every step records who did it");
  assert.equal((await one(`select count(*)::int as n from commission_ledger where payout_id = $1 and status <> 'paid'`, [payoutId])).n, 0);
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "paid" } })).status, 200, "retrying 'paid' is a no-op");
  assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { email: ADMIN, body: { status: "failed", failureReason: "x" } })).status, 409, "a paid payout cannot fail");
  const audits = (await sql(`select action from audit_logs where entity_type = 'payout' and entity_id = $1 order by id`, [p.payout_number])).rows.map((r) => r.action);
  assert.deepEqual(audits, ["payout_calculated", "payout_approved", "payout_processing", "payout_paid"]);
});

test("a refund after payout creates an approved clawback that waits for the next payout", { skip }, async () => {
  const paidLine = await one(
    `select a.order_item_id, a.order_id, a.amount, a.quantity from commission_ledger a join order_items i on i.id = a.order_item_id
     where a.payout_id = $1 and a.entry_type = 'accrual' and a.kind = 'team_leader' and i.refunded_quantity = 0 and a.seller_reseller_id <> all(select id from resellers where user_id in (select id from users where email like '%@masmila.co.za')) limit 1`,
    [payoutId],
  );
  assert.ok(paidLine, "a paid scenario line without refunds");
  await refundVia(paidLine.order_id, { type: "refund", items: [{ orderItemId: paidLine.order_item_id, quantity: 1 }] });
  const clawback = await one(`select * from commission_ledger where order_item_id = $1 and entry_type = 'reversal' and beneficiary_reseller_id = $2`, [paidLine.order_item_id, nomdade.id]);
  assert.equal(clawback.status, "approved");
  assert.equal(clawback.payout_id, null);
  assert.match(clawback.note, /^Clawback/);
  assert.equal(Number(clawback.amount), -r2(Number(paidLine.amount) / paidLine.quantity));
  assert.equal((await one(`select count(*)::int as n from fraud_flags where order_id = $1 and type = 'refund_commission'`, [paidLine.order_id])).n, 1);
  // This period's payout is already paid: the clawback carries forward (a net negative balance is never paid out).
  const res = await call("POST", "/admin/payouts", { email: ADMIN, body: { period, resellerIds: [nomdade.id] } });
  assert.deepEqual(res.body, []);
});

// ---------------------------------------------------------------- 10. authorization
test("10. payout creation/steps, commission approval and refunds are admin-only and have no side effects otherwise", { skip }, async () => {
  const counts = async () => one(`select (select count(*) from payouts)::int as payouts, (select count(*) from refunds)::int as refunds, (select count(*) from commission_ledger where status = 'approved')::int as approved, (select string_agg(status, ',' order by id) from payouts) as statuses`);
  const beforeCounts = await counts();
  const pending = await one(`select id, order_id from commission_ledger where status = 'pending' and entry_type = 'accrual' limit 1`);
  const order = await one(`select id from orders where status in ('paid', 'partially_refunded') limit 1`);
  for (const [email, expected] of [[undefined, 401], [CUSTOMER, 403], [TEAM_LEADER, 403], [MANAGER, 403]] as const) {
    const opts = { email, body: {} };
    assert.equal((await call("POST", "/admin/payouts", { ...opts, body: { period, resellerIds: [nomdade.id] } })).status, expected, `${email} create`);
    assert.equal((await call("PATCH", `/admin/payouts/${payoutId}`, { ...opts, body: { status: "failed", failureReason: "x" } })).status, expected, `${email} step`);
    assert.equal((await call("POST", "/admin/commissions/approve", { ...opts, body: { ids: pending ? [pending.id] : [1] } })).status, expected, `${email} approve`);
    assert.equal((await call("POST", `/admin/orders/${order.id}/refund`, { ...opts, body: { type: "refund", reason: "nope" } })).status, expected, `${email} refund`);
  }
  assert.deepEqual(await counts(), beforeCounts);
});

// ---------------------------------------------------------------- 11. reconciliation
test("11. ledger, refunds and payouts reconcile against independently calculated amounts", { skip }, async () => {
  // Independent model of the reversal rule: each refund reverses its proportional share of the
  // accrual (rounded to cents, capped at what is left); the refund that completes the line reverses the rest.
  const accruals = (await sql(`select a.*, i.quantity as line_qty from commission_ledger a join order_items i on i.id = a.order_item_id where a.entry_type = 'accrual' and a.status in ('pending','approved','paid')`)).rows;
  let checked = 0;
  for (const a of accruals) {
    const refundItems = (await sql(`select ri.refund_id, ri.quantity from refund_items ri join refunds r on r.id = ri.refund_id where ri.order_item_id = $1 and r.order_was_paid order by ri.id`, [a.order_item_id])).rows;
    let remaining = Number(a.amount);
    let refunded = 0;
    const expected = new Map<number, number>();
    for (const ri of refundItems) {
      refunded += ri.quantity;
      const share = refunded >= a.line_qty ? remaining : Math.min(remaining, r2((Number(a.amount) * ri.quantity) / a.line_qty));
      if (share > 0) expected.set(ri.refund_id, -share);
      remaining = r2(remaining - share);
    }
    const actual = (await sql(`select refund_id, amount, quantity from commission_ledger where reversal_of_id = $1 and status <> 'void'`, [a.id])).rows;
    assert.equal(actual.length, expected.size, `accrual ${a.id}: one reversal per refund`);
    for (const r of actual) {
      assert.ok(r.refund_id, `accrual ${a.id}: reversal linked to a refund`);
      assert.equal(Number(r.amount), expected.get(r.refund_id), `accrual ${a.id}, refund ${r.refund_id}`);
      const item = refundItems.find((i) => i.refund_id === r.refund_id)!;
      assert.equal(-r.quantity, item.quantity);
    }
    const netAmount = r2(Number(a.amount) + actual.reduce((s, r) => s + Number(r.amount), 0));
    assert.ok(netAmount >= 0, `accrual ${a.id} never over-reversed`);
    if (refunded >= a.line_qty) assert.equal(netAmount, 0, `accrual ${a.id}: fully refunded line nets to zero`);
    checked++;
  }
  assert.ok(checked > 10, `checked ${checked} accruals`);

  // Refund records add up, and match the order lines.
  const refundMismatch = await one(`select count(*)::int as n from refunds r where r.amount <> (select coalesce(sum(amount),0) from refund_items where refund_id = r.id)`);
  assert.equal(refundMismatch.n, 0);
  const lineMismatch = await one(
    `select count(*)::int as n from order_items i where i.refunded_quantity <> (select coalesce(sum(ri.quantity),0) from refund_items ri join refunds r on r.id = ri.refund_id where ri.order_item_id = i.id and r.order_was_paid)`,
  );
  assert.equal(lineMismatch.n, 0);

  // Payouts equal the rows allocated to them; paid payouts only hold paid rows; failed ones hold none.
  const payouts = (await sql(`select p.*, (select coalesce(sum(amount),0) from commission_ledger where payout_id = p.id) as allocated, (select count(*) from commission_ledger where payout_id = p.id)::int as rows, (select count(*) from commission_ledger where payout_id = p.id and status <> 'paid')::int as unpaid_rows from payouts p`)).rows;
  for (const p of payouts) {
    if (p.status === "failed") assert.equal(p.rows, 0, `${p.payout_number} released`);
    else {
      assert.equal(Number(p.allocated), Number(p.amount), `${p.payout_number} amount`);
      assert.equal(p.rows, p.entry_count, `${p.payout_number} entries`);
    }
    if (p.status === "paid") assert.equal(p.unpaid_rows, 0, `${p.payout_number} rows paid`);
  }
  // No ledger row is paid without a paid payout.
  const orphanPaid = await one(`select count(*)::int as n from commission_ledger l left join payouts p on p.id = l.payout_id where l.status = 'paid' and (p.id is null or p.status <> 'paid')`);
  assert.equal(orphanPaid.n, 0);
});
