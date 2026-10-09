/**
 * Client acceptance rehearsal: the acceptance checklist (docs/LAUNCH_READINESS.md)
 * walked end to end over HTTP against the real app on a DISPOSABLE local
 * database (TEST_ACCEPTANCE_DATABASE_URL, migrations applied, may start empty
 * — the demo network is seeded into it). Tests run in order and build one
 * story: a customer, a new reseller in Nomdade's team, her opening order, a
 * refund, month-end, payout and the administrator's view.
 *
 * Sign-in uses the test-mode demo token, not Clerk; Shopify payments are
 * synthetic signed payloads. Real Clerk and Shopify are verified on staging.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabaseUrl } from "./helpers";

const url = testDatabaseUrl("TEST_ACCEPTANCE_DATABASE_URL");
const skip = url ? false : "TEST_ACCEPTANCE_DATABASE_URL not set";
const SECRET = "acceptance-test-secret";
for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "DISABLE_DEMO_AUTH", "ADMIN_EMAILS", "DEMO_AUTH", "SEED_DEMO_DATA", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN", "REPLIT_CONNECTORS_HOSTNAME", "TRUSTED_PROXY_HOPS"]) delete process.env[key];
Object.assign(process.env, { NODE_ENV: "test", LOG_LEVEL: "silent", SHOPIFY_WEBHOOK_SECRET: SECRET });
if (url) process.env.DATABASE_URL = url;

const ADMIN = "admin@masmila.co.za";
const TEAM_LEADER = "teamleader@masmila.co.za";
const tag = randomUUID().slice(0, 6);
const CUSTOMER = `acc-customer-${tag}@acceptance.test`;
const NEW_RESELLER = `acc-reseller-${tag}@acceptance.test`;

let server: Server;
let base = "";
let D: typeof import("@workspace/db");
let period = "";

async function call(method: string, path: string, o: { email?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(o.email ? { authorization: `Bearer demo:${o.email}` } : {}), ...o.headers },
    body: o.raw ?? (method === "GET" ? undefined : JSON.stringify(o.body ?? {})),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* csv or empty */
  }
  return { status: response.status, body, text, type: response.headers.get("content-type") ?? "" };
}
const one = async (text: string, params: unknown[] = []) => (await D.pool.query(text, params)).rows[0];
const address = { line1: "12 Acceptance Avenue", city: "Johannesburg", province: "Gauteng", postalCode: "2001" };

// Shared story state.
let product: { id: number; resellerPrice: number; retailPrice: number };
let customerOrder: { id: number; orderNumber: string; total: number };
let resellerId = 0;
let openingOrder: { id: number; orderNumber: string };
let nomdadeId = 0;

before(async () => {
  if (skip) return;
  D = await import("@workspace/db");
  const { prepareData } = await import("../lib/prepare");
  const { currentPeriod } = await import("../lib/period");
  const { default: app } = await import("../app");
  await prepareData();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  period = currentPeriod();
  const [p] = await D.db
    .insert(D.productsTable)
    .values({ slug: `acc-${tag}`, sku: `ACC-${tag}`, name: `Acceptance Oud ${tag}`, category: "Unisex", family: "Woody", size: "50ml", retailPrice: 299, recommendedRetailPrice: 299, resellerPrice: 140, cost: 50, stockQuantity: 100 })
    .returning();
  product = p!;
  nomdadeId = (await one(`select r.id from resellers r join users u on u.id = r.user_id where u.email = $1`, [TEAM_LEADER])).id;
});
after(async () => {
  if (skip) return;
  server?.close();
  await D?.pool.end();
});

test("AC1. customer registration and purchase (EFT, confirmed by an administrator)", { skip }, async () => {
  const me = await call("GET", "/me", { email: CUSTOMER });
  assert.deepEqual([me.status, me.body.signedIn, me.body.isAdmin], [200, true, false], "first sign-in creates a customer account");
  assert.equal((await call("PATCH", "/me", { email: CUSTOMER, body: { firstName: "Ayanda", surname: "Khumalo", mobile: "0831112222" } })).status, 200);
  const checkout = await call("POST", "/checkout", {
    email: CUSTOMER,
    body: { mode: "retail", items: [{ productId: product.id, quantity: 2 }], customer: { firstName: "Ayanda", surname: "Khumalo", email: CUSTOMER, mobile: "0831112222" }, address, paymentMethod: "eft", idempotencyKey: randomUUID() },
  });
  assert.equal(checkout.status, 201, checkout.text);
  customerOrder = checkout.body.order;
  assert.equal(customerOrder.total, 2 * 299 + checkout.body.order.shippingFee);
  assert.match(checkout.body.paymentInstructions, new RegExp(`reference ${customerOrder.orderNumber}`));
  assert.equal((await call("PATCH", `/admin/orders/${customerOrder.id}`, { email: ADMIN, body: { status: "paid" } })).status, 200);
  const mine = await call("GET", "/me/orders", { email: CUSTOMER });
  assert.deepEqual(mine.body.map((o: { orderNumber: string; status: string }) => [o.orderNumber, o.status]), [[customerOrder.orderNumber, "paid"]]);
  const tracked = await call("GET", `/orders/track?orderNumber=${customerOrder.orderNumber}&email=${encodeURIComponent(CUSTOMER)}`);
  assert.equal(tracked.status, 200);
  assert.equal((await call("GET", `/orders/track?orderNumber=${customerOrder.orderNumber}&email=someone@else.test`)).status, 404, "tracking needs the order's email");
});

test("AC2. reseller application, administrator approval and sponsor placement", { skip }, async () => {
  const nomdadeCode = (await one(`select referral_code from resellers where id = $1`, [nomdadeId])).referral_code;
  assert.equal((await call("GET", "/reseller/dashboard", { email: NEW_RESELLER })).status, 403, "no portal before approval");
  const apply = await call("POST", "/reseller-applications", {
    email: NEW_RESELLER,
    body: { firstName: "Zinhle", surname: "Ndlovu", mobile: "0844445555", email: NEW_RESELLER, province: "Gauteng", city: "Soweto", contactMethod: "whatsapp", heardAbout: "A friend", referringCode: nomdadeCode, termsAccepted: true, privacyAccepted: true, resellerTermsAccepted: true },
  });
  assert.equal(apply.status, 201, apply.text);
  const pending = await call("GET", "/admin/applications?status=pending", { email: ADMIN });
  const application = pending.body.find((a: { email: string }) => a.email === NEW_RESELLER);
  assert.ok(application, "the administrator sees the application");
  assert.equal((await call("POST", `/admin/applications/${application.id}/decision`, { email: TEAM_LEADER, body: { decision: "approve" } })).status, 403, "only administrators decide");
  const decision = await call("POST", `/admin/applications/${application.id}/decision`, { email: ADMIN, body: { decision: "approve" } });
  assert.equal(decision.status, 200, decision.text);
  const reseller = await one(`select r.id, r.sponsor_id from resellers r join users u on u.id = r.user_id where u.email = $1`, [NEW_RESELLER]);
  resellerId = reseller.id;
  assert.equal(reseller.sponsor_id, nomdadeId, "placed under the referring Team Leader");
  assert.equal((await call("GET", "/reseller/dashboard", { email: NEW_RESELLER })).status, 200);
});

test("AC3. reseller pricing visible only to resellers; opening-order minimum enforced", { skip }, async () => {
  const asCustomer = await call("GET", `/products/${product.id ? (await one(`select slug from products where id = $1`, [product.id])).slug : ""}`, { email: CUSTOMER });
  const asReseller = await call("GET", `/products/${asCustomer.body.slug}`, { email: NEW_RESELLER });
  assert.equal(asCustomer.body.resellerPrice, null, "customers never see wholesale prices");
  assert.equal(asReseller.body.resellerPrice, 140);
  const order = (quantity: number) =>
    call("POST", "/checkout", { email: NEW_RESELLER, body: { mode: "reseller", items: [{ productId: product.id, quantity }], customer: { firstName: "Zinhle", surname: "Ndlovu", email: NEW_RESELLER, mobile: "0844445555" }, address, paymentMethod: "eft" } });
  const tooSmall = await order(9);
  assert.equal(tooSmall.status, 400);
  assert.match(tooSmall.body.error, /opening order needs at least 10 bottles/);
  assert.equal((await call("POST", "/checkout", { email: CUSTOMER, body: { mode: "reseller", items: [{ productId: product.id, quantity: 10 }], customer: { firstName: "A", surname: "K", email: CUSTOMER, mobile: "0831112222" }, address, paymentMethod: "eft" } })).status, 403, "customers cannot order at wholesale");
  const opening = await order(10);
  assert.equal(opening.status, 201, opening.text);
  assert.equal(opening.body.order.items[0].unitPrice, 140);
  openingOrder = opening.body.order;
});

test("AC4/AC5. paid opening order accrues upline incentives; a partial refund reverses them exactly", { skip }, async () => {
  assert.equal((await call("PATCH", `/admin/orders/${openingOrder.id}`, { email: ADMIN, body: { status: "paid" } })).status, 200);
  const team = await call("GET", "/reseller/team", { email: TEAM_LEADER });
  assert.ok(JSON.stringify(team.body).includes("Zinhle"), "the new reseller appears in the Team Leader's team");
  const net = async () => Number((await one(`select coalesce(sum(amount),0) as t from commission_ledger where order_id = $1 and beneficiary_reseller_id = $2 and status in ('pending','approved','paid')`, [openingOrder.id, nomdadeId])).t);
  assert.equal(await net(), 70, "Team Leader 5% × 10 × R140");
  const item = (await one(`select id from order_items where order_id = $1`, [openingOrder.id])).id;
  const refund = await call("POST", `/admin/orders/${openingOrder.id}/refund`, { email: ADMIN, body: { type: "return", reason: "Two damaged bottles", items: [{ orderItemId: item, quantity: 2 }], idempotencyKey: randomUUID() } });
  assert.equal(refund.status, 200, refund.text);
  assert.equal(await net(), 56, "reversed exactly 2/10");
});

test("AC4. month-end qualification runs (leased) and records every reseller", { skip }, async () => {
  const run = await call("POST", "/admin/qualification", { email: ADMIN, body: { period } });
  assert.equal(run.status, 200, run.text);
  assert.ok(run.body.rows.some((r: { resellerId: number }) => r.resellerId === resellerId));
  assert.equal((await one(`select status from period_runs where period = $1`, [period])).status, "closed");
  const jobs = await call("GET", "/admin/jobs", { email: ADMIN });
  assert.ok(jobs.body.runs.some((r: { period: string; status: string; trigger: string }) => r.period === period && r.status === "succeeded" && r.trigger === "admin"));
});

test("AC6. payout: calculated once, authorised step by step, reconciled with the ledger", { skip }, async () => {
  const ids = (await D.pool.query(`select id from commission_ledger where beneficiary_reseller_id = $1 and status = 'pending' and entry_type = 'accrual'`, [nomdadeId])).rows.map((r) => r.id);
  assert.ok(ids.length);
  assert.equal((await call("POST", "/admin/commissions/approve", { email: TEAM_LEADER, body: { ids } })).status, 403, "resellers cannot approve");
  assert.equal((await call("POST", "/admin/commissions/approve", { email: ADMIN, body: { ids } })).status, 200);
  const owed = Number((await one(`select coalesce(sum(amount),0) as t from commission_ledger where beneficiary_reseller_id = $1 and status = 'approved' and payout_id is null and period <= $2`, [nomdadeId, period])).t);
  const [a, b] = await Promise.all([1, 2].map(() => call("POST", "/admin/payouts", { email: ADMIN, body: { period, resellerIds: [nomdadeId] } })));
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 201), `${a.text} ${b.text}`);
  const payouts = (await D.pool.query(`select * from payouts where reseller_id = $1 and period = $2`, [nomdadeId, period])).rows;
  assert.equal(payouts.length, 1, "a double-submitted calculation creates one payout");
  const payout = payouts[0];
  assert.equal(Number(payout.amount), Math.round(owed * 100) / 100, "payout = approved, unallocated incentives (net of the refund)");
  const allocated = await one(`select coalesce(sum(amount),0) as t from commission_ledger where payout_id = $1`, [payout.id]);
  assert.equal(Number(allocated.t), Number(payout.amount), "reconciles with its ledger rows");
  const step = (status: string, extra: Record<string, unknown> = {}, email = ADMIN) => call("PATCH", `/admin/payouts/${payout.id}`, { email, body: { status, ...extra } });
  assert.equal((await step("approved", {}, TEAM_LEADER)).status, 403);
  assert.equal((await step("paid")).status, 409, "cannot skip approval");
  assert.equal((await step("approved")).status, 200);
  assert.equal((await step("processing", { reference: "ACC-BATCH-1" })).status, 200);
  assert.equal((await step("paid")).status, 200, "recorded as paid — no money is moved by the system");
  assert.equal((await one(`select count(*)::int as n from commission_ledger where payout_id = $1 and status <> 'paid'`, [payout.id])).n, 0);
});

test("AC7. payment exception: quarantined, investigated and resolved by an administrator, with audit", { skip }, async () => {
  const checkout = await call("POST", "/checkout", { email: CUSTOMER, body: { mode: "retail", items: [{ productId: product.id, quantity: 1 }], customer: { firstName: "Ayanda", surname: "Khumalo", email: CUSTOMER, mobile: "0831112222" }, address, paymentMethod: "eft" } });
  const order = checkout.body.order;
  await D.pool.query(`update orders set payment_method = 'shopify' where id = $1`, [order.id]);
  const raw = JSON.stringify({ id: 9_700_001, name: "#ACC1", financial_status: "paid", currency: "ZAR", total_price: "10.00", total_price_set: { shop_money: { amount: "10.00", currency_code: "ZAR" } }, total_outstanding: "0.00", test: false, cancelled_at: null, note_attributes: [{ name: "masmila_order", value: order.orderNumber }] });
  const hook = await call("POST", "/webhooks/shopify", { raw, headers: { "x-shopify-topic": "orders/paid", "x-shopify-webhook-id": randomUUID(), "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(raw).digest("base64") } });
  assert.deepEqual([hook.body.outcome, hook.body.reason], ["rejected", "underpayment"]);
  assert.equal((await call("GET", "/admin/payment-events", { email: CUSTOMER })).status, 403);
  const queue = await call("GET", `/admin/payment-events?q=${order.orderNumber}`, { email: ADMIN });
  const event = queue.body[0];
  assert.deepEqual([event.reason, event.amount, event.expectedAmount, event.review], ["underpayment", 10, order.total, "open"]);
  const resolved = await call("POST", `/admin/payment-events/${event.id}/resolve`, { email: ADMIN, body: { action: "refunded_in_shopify", reason: "Refunded R10.00 in Shopify; asked customer to pay by EFT" } });
  assert.equal(resolved.status, 200);
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment", "resolution never marks the order paid");
  assert.equal((await one(`select status from fraud_flags where payment_event_id = $1`, [event.id])).status, "resolved");
});

test("AC8. stock reservation, cancellation and recovery", { skip }, async () => {
  const stock = async () => one(`select stock_quantity as s, reserved_quantity as r from products where id = $1`, [product.id]);
  const before = await stock();
  const checkout = await call("POST", "/checkout", { email: CUSTOMER, body: { mode: "retail", items: [{ productId: product.id, quantity: 3 }], customer: { firstName: "Ayanda", surname: "Khumalo", email: CUSTOMER, mobile: "0831112222" }, address, paymentMethod: "eft" } });
  assert.equal((await stock()).r, before.r + 3, "reserved at checkout");
  const cancel = await call("POST", `/admin/orders/${checkout.body.order.id}/refund`, { email: ADMIN, body: { type: "cancel", reason: "Customer changed their mind", idempotencyKey: randomUUID() } });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await stock(), before, "reservation released, stock untouched");
});

test("AC9. reports, audit trail, privacy of customer data and administrator-only access", { skip }, async () => {
  const csv = await call("GET", "/admin/reports?type=orders&format=csv", { email: ADMIN });
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/csv/);
  assert.ok(csv.text.includes(customerOrder.orderNumber));
  for (const email of [CUSTOMER, NEW_RESELLER, TEAM_LEADER]) {
    for (const path of ["/admin/reports?type=orders", "/admin/audit-logs", "/admin/orders", "/admin/payouts", "/admin/customers"]) {
      assert.equal((await call("GET", path, { email })).status, 403, `${email} ${path}`);
    }
  }
  assert.equal((await call("GET", "/admin/orders")).status, 401);
  const actions = new Set<string>();
  for (const entityType of ["order", "payout", "payment_event", "report"]) {
    const audit = await call("GET", `/admin/audit-logs?entityType=${entityType}`, { email: ADMIN });
    assert.equal(audit.status, 200);
    for (const a of audit.body as Array<{ action: string }>) actions.add(a.action);
  }
  for (const action of ["order_paid", "order_return", "payout_approved", "payout_paid", "payment_event_resolved", "report_exported"]) assert.ok(actions.has(action), `audit log has ${action}`);
  // A reseller sees referred customers' sales only in masked form.
  const referral = (await one(`select referral_code from resellers where id = $1`, [nomdadeId])).referral_code;
  const referred = await call("POST", "/checkout", { body: { mode: "retail", items: [{ productId: product.id, quantity: 1 }], customer: { firstName: "Private", surname: "Person", email: `private-${tag}@acceptance.test`, mobile: "0829998877" }, address, paymentMethod: "eft", referralCode: referral } });
  assert.equal(referred.status, 201);
  const sales = await call("GET", "/reseller/sales", { email: TEAM_LEADER });
  const sale = sales.body.find((s: { orderNumber: string }) => s.orderNumber === referred.body.order.orderNumber);
  assert.ok(sale);
  assert.ok(!sales.text.includes(`private-${tag}@acceptance.test`) && !sales.text.includes("0829998877") && !sales.text.includes(address.line1), "no full customer contact details");
  assert.equal(sale.customerName, "Private P.");
  // Customers see only their own orders.
  assert.ok((await call("GET", "/me/orders", { email: CUSTOMER })).body.every((o: { customerEmail: string }) => o.customerEmail === CUSTOMER));
});
