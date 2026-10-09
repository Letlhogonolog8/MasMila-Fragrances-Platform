/**
 * Operational reliability (Phase 4), against the real code on a DISPOSABLE
 * local database (TEST_OPS_DATABASE_URL, migrations applied, may start empty
 * — the demo network is seeded into it). Timeouts and the month-end lease are
 * shortened so that expiry, contention and recovery happen within seconds.
 * Payment notifications are synthetic, signed with a test secret.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabaseUrl } from "./helpers";

const url = testDatabaseUrl("TEST_OPS_DATABASE_URL");
const skip = url ? false : "TEST_OPS_DATABASE_URL not set";
const SECRET = "ops-test-secret";

for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "DISABLE_DEMO_AUTH", "ADMIN_EMAILS", "DEMO_AUTH", "SEED_DEMO_DATA", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN", "REPLIT_CONNECTORS_HOSTNAME", "TRUSTED_PROXY_HOPS"]) delete process.env[key];
Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  SHOPIFY_WEBHOOK_SECRET: SECRET,
  DB_LOCK_TIMEOUT_MS: "1500",
  DB_STATEMENT_TIMEOUT_MS: "2000",
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "1500",
  DB_CONNECTION_TIMEOUT_MS: "2000",
  MONTH_END_LEASE_MS: "1500",
  MONTH_END_RETRY_BASE_MS: "60000",
});
if (url) process.env.DATABASE_URL = url;

const ADMIN = "admin@masmila.co.za";
const CUSTOMER = "customer@masmila.co.za";
const RESELLER = "teamleader@masmila.co.za";

let server: Server;
let base = "";
let D: typeof import("@workspace/db");
let O: typeof import("drizzle-orm");
let jobs: typeof import("../lib/jobs");
let orders: typeof import("../lib/orders");
let period: typeof import("../lib/period");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Call = { email?: string; body?: unknown; headers?: Record<string, string>; raw?: string };
async function call(method: string, path: string, o: Call = {}) {
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
    /* empty */
  }
  return { status: response.status, body, text };
}
const sql = (text: string, params: unknown[] = []) => D.pool.query(text, params);
const one = async (text: string, params: unknown[] = []) => (await sql(text, params)).rows[0];
const count = async (text: string, params: unknown[] = []) => Number((await one(text, params)).n);

let seq = 0;
async function makeProduct(stockQuantity: number) {
  const tag = randomUUID().slice(0, 8);
  const [p] = await D.db
    .insert(D.productsTable)
    .values({ slug: `ops-${tag}`, sku: `OPS-${tag}`, name: `Ops test ${++seq}`, category: "Unisex", family: "Fresh", size: "50ml", retailPrice: 299, recommendedRetailPrice: 299, resellerPrice: 140, cost: 50, stockQuantity })
    .returning();
  return p!;
}
async function placeOrder(productId: number, quantity = 1) {
  const tag = randomUUID().slice(0, 8);
  const { orderId } = await orders.createOrder(
    {
      mode: "retail",
      items: [{ productId, quantity }],
      customer: { firstName: "Ops", surname: "Tester", email: `ops-${tag}@ops.test`, mobile: "0820000000" },
      address: { line1: "1 Ops Road", city: "Durban", province: "KwaZulu-Natal", postalCode: "4001" },
      paymentMethod: "eft",
    },
    { user: null, reseller: null },
  );
  return one(`select * from orders where id = $1`, [orderId]);
}
const stockOf = async (productId: number) => {
  const r = await one(`select stock_quantity as s, reserved_quantity as r from products where id = $1`, [productId]);
  return { stock: Number(r.s), reserved: Number(r.r) };
};
const markPaid = (orderId: number) => call("PATCH", `/admin/orders/${orderId}`, { email: ADMIN, body: { status: "paid" } });

let shopifyIds = 9_300_000;
function hook(payload: object) {
  const raw = JSON.stringify(payload);
  return call("POST", "/webhooks/shopify", { raw, headers: { "x-shopify-topic": "orders/paid", "x-shopify-webhook-id": randomUUID(), "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(raw).digest("base64") } });
}
function payment(order: { order_number: string; total: string | number }, over: Record<string, unknown> = {}) {
  const id = ++shopifyIds;
  const amount = Number(order.total).toFixed(2);
  return { id, name: `#${id}`, financial_status: "paid", currency: "ZAR", total_price: amount, total_price_set: { shop_money: { amount, currency_code: "ZAR" } }, total_outstanding: "0.00", test: false, cancelled_at: null, note_attributes: [{ name: "masmila_order", value: order.order_number }], ...over };
}

before(async () => {
  if (skip) return;
  D = await import("@workspace/db");
  O = await import("drizzle-orm");
  jobs = await import("../lib/jobs");
  orders = await import("../lib/orders");
  period = await import("../lib/period");
  const { prepareData } = await import("../lib/prepare");
  const { default: app } = await import("../app");
  await prepareData();
  // Every reseller existed in the test months below, so each month-end run processes all of them.
  await sql(`update resellers set approved_at = now() - interval '400 days'`);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => {
  if (skip) return;
  server?.close();
  await D?.pool.end();
});

const monthsAgo = (n: number) => period.shiftPeriod(period.currentPeriod(), -n);
const monthRow = (p: string) => one(`select * from period_runs where period = $1`, [p]);
const runsFor = (p: string) => sql(`select * from job_runs where job = 'month_end_qualification' and period = $1 order by id`, [p]).then((r) => r.rows);
const adminAlerts = (p: string) => count(`select count(*)::int as n from notifications where audience = 'admin' and type = 'job_failed' and title like $1`, [`%${p}%`]);

// ================================================================ 1. month-end qualification

test("M1. concurrent month-end invocations: exactly one runs, the rest skip; a closed month is not re-run automatically", { skip }, async () => {
  const p = monthsAgo(1);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => jobs.runMonthEnd(p, { trigger: "test" })));
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["skipped", "skipped", "skipped", "skipped", "skipped", "succeeded"]);
  for (const o of outcomes) if (o.status === "skipped") assert.equal(o.reason, "running");
  const row = await monthRow(p);
  assert.deepEqual([row.status, row.attempts, row.lease_owner, row.last_error], ["closed", 1, null, null]);
  assert.ok(row.started_at && row.finished_at);
  const runs = await runsFor(p);
  assert.deepEqual(runs.map((r) => r.status), ["succeeded"]);
  assert.equal((await jobs.runMonthEnd(p, { trigger: "test" })).status, "skipped");
  // runDueJobs (the scheduler entry point) finds nothing left to do for it.
  const due = await jobs.runDueJobs("test");
  assert.ok(due.monthEnd.every((o) => o.period !== p || o.status === "skipped"));
});

test("M2. a failed run is recorded, alerted, retried after its delay and completes without applying anything twice", { skip }, async () => {
  const p = monthsAgo(2);
  const ranksBefore = new Map((await sql(`select id, rank from resellers`)).rows.map((r) => [r.id, r.rank]));
  const failed = await jobs.runMonthEnd(p, { trigger: "test", hooks: { afterReseller: async (n) => { if (n === 3) throw new Error("injected failure after 3 resellers"); } } });
  assert.equal(failed.status, "failed");
  let row = await monthRow(p);
  assert.deepEqual([row.status, row.attempts, row.lease_owner], ["failed", 1, null]);
  assert.match(row.last_error, /injected failure/);
  assert.equal(await count(`select count(*)::int as n from qualification_periods where period = $1`, [p]), 3, "three resellers were written before the failure");
  assert.equal(await adminAlerts(p), 1, "administrators alerted");

  // Too soon: waits for its retry delay instead of hammering.
  const early = await jobs.runMonthEnd(p, { trigger: "test" });
  assert.deepEqual([early.status, early.status === "skipped" && early.reason], ["skipped", "retry_later"]);
  await sql(`update period_runs set run_at = now() - interval '2 hours' where period = $1`, [p]);
  const retried = await jobs.runMonthEnd(p, { trigger: "test" });
  assert.deepEqual([retried.status, retried.status === "succeeded" && retried.attempt], ["succeeded", 2]);
  row = await monthRow(p);
  assert.deepEqual([row.status, row.attempts, row.last_error], ["closed", 2, null]);
  assert.deepEqual((await runsFor(p)).map((r) => [r.attempt, r.status]), [[1, "failed"], [2, "succeeded"]]);

  // Resumed correctly: every reseller judged from the rank it had before the first attempt, once.
  const snapshots = (await sql(`select reseller_id, rank_before, rank_after from qualification_periods where period = $1`, [p])).rows;
  assert.equal(snapshots.length, ranksBefore.size);
  for (const s of snapshots) assert.equal(s.rank_before, ranksBefore.get(s.reseller_id), `reseller ${s.reseller_id} judged from its original rank`);
  const ranksAfter = new Map((await sql(`select id, rank from resellers`)).rows.map((r) => [r.id, r.rank]));
  for (const s of snapshots) assert.equal(ranksAfter.get(s.reseller_id), s.rank_after);
});

test("M3. a crashed runner (process died mid-month) is taken over once its lease expires, and the month completes", { skip }, async () => {
  const p = monthsAgo(3);
  // The "crashed" runner stops forever after its second reseller and never renews or releases its lease.
  void jobs.runMonthEnd(p, { trigger: "test", hooks: { afterReseller: (n) => (n === 2 ? new Promise<void>(() => {}) : Promise.resolve()) } });
  await sleep(300);
  assert.equal((await monthRow(p)).status, "running");
  assert.equal((await jobs.runMonthEnd(p, { trigger: "test" })).status, "skipped", "the live lease is respected");
  await sleep(1700); // lease (1.5 s) expires
  const recovered = await jobs.runMonthEnd(p, { trigger: "test" });
  assert.deepEqual([recovered.status, recovered.status === "succeeded" && recovered.attempt], ["succeeded", 2]);
  assert.equal((await monthRow(p)).status, "closed");
  assert.deepEqual((await runsFor(p)).map((r) => r.status), ["abandoned", "succeeded"]);
});

test("M4. a runner that times out (outlives its lease) is superseded and cannot settle the month", { skip }, async () => {
  const p = monthsAgo(4);
  const slow = jobs.runMonthEnd(p, { trigger: "test", hooks: { afterReseller: (n) => (n === 1 ? sleep(3000) : Promise.resolve()) } });
  await sleep(1800);
  const takeover = await jobs.runMonthEnd(p, { trigger: "test" });
  assert.equal(takeover.status, "succeeded");
  const stale = await slow;
  assert.equal(stale.status, "abandoned", "the timed-out runner noticed it lost the lease and stopped");
  const row = await monthRow(p);
  assert.deepEqual([row.status, row.lease_owner], ["closed", null]);
  assert.deepEqual((await runsFor(p)).map((r) => r.status).sort(), ["abandoned", "succeeded"]);
  assert.equal(await count(`select count(*)::int as n from audit_logs where entity_type = 'period' and entity_id = $1`, [p]), 1, "settled once");
});

test("M5. a stalled final attempt is marked failed and alerted once; an administrator can still run the month", { skip }, async () => {
  const p = monthsAgo(5);
  await sql(`insert into period_runs (period, status, run_at, attempts, lease_owner, lease_expires_at, started_at) values ($1, 'running', now(), 5, 'dead-host:1', now() - interval '1 minute', now())`, [p]);
  const first = await jobs.runMonthEnd(p, { trigger: "test" });
  assert.deepEqual([first.status, first.status === "skipped" && first.reason], ["skipped", "max_attempts"]);
  assert.equal((await monthRow(p)).status, "failed", "no longer silently 'running'");
  await jobs.runMonthEnd(p, { trigger: "test" });
  assert.equal(await adminAlerts(p), 1, "alerted once, not every hour");
  const manual = await call("POST", "/admin/qualification", { email: ADMIN, body: { period: p } });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal((await monthRow(p)).status, "closed");
});

test("M6. an administrator's run never overlaps a running one (409), and the job history is visible to admins only", { skip }, async () => {
  const p = monthsAgo(6);
  await sql(`insert into period_runs (period, status, run_at, attempts, lease_owner, lease_expires_at, started_at) values ($1, 'running', now(), 1, 'other-host:1', now() + interval '10 minutes', now())`, [p]);
  const res = await call("POST", "/admin/qualification", { email: ADMIN, body: { period: p } });
  assert.equal(res.status, 409);
  assert.equal((await monthRow(p)).lease_owner, "other-host:1", "the running owner keeps the month");
  const overview = await call("GET", "/admin/jobs", { email: ADMIN });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.months.some((m: { period: string; status: string }) => m.period === monthsAgo(2) && m.status === "closed"));
  assert.ok(overview.body.runs.some((r: { status: string }) => r.status === "abandoned"));
  for (const email of [undefined, CUSTOMER, RESELLER]) assert.ok([401, 403].includes((await call("GET", "/admin/jobs", { email })).status));
});

// ================================================================ 2. unpaid EFT reservations

test("E1. expiry is off until a reservation period is set (business decision)", { skip }, async () => {
  const product = await makeProduct(10);
  const order = await placeOrder(product.id);
  await sql(`update orders set created_at = now() - interval '30 days' where id = $1`, [order.id]);
  const result = await jobs.expireUnpaidOrders({ trigger: "test" });
  assert.deepEqual([result.enabled, result.expired], [false, 0]);
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment");
});

test("E2. expired unpaid EFT orders are cancelled once (duplicate and concurrent runs), stock released once", { skip }, async () => {
  const set = await call("PATCH", "/admin/settings", { email: ADMIN, body: { eftReservationHours: 48 } });
  assert.equal(set.status, 200);
  assert.equal(set.body.eftReservationHours, 48);
  assert.equal(await count(`select count(*)::int as n from audit_logs where action = 'compensation_settings_updated' and metadata like '%eftReservationHours%'`), 1, "setting change audited");
  assert.equal((await call("PATCH", "/admin/settings", { email: ADMIN, body: { eftReservationHours: 0 } })).status, 400, "zero is not a duration");

  const product = await makeProduct(10);
  const baseline = await stockOf(product.id);
  const old = await placeOrder(product.id, 2);
  const recent = await placeOrder(product.id, 1);
  await sql(`update orders set created_at = now() - interval '49 hours' where id = $1`, [old.id]);
  assert.deepEqual(await stockOf(product.id), { stock: baseline.stock, reserved: baseline.reserved + 3 });

  const due = await count(`select count(*)::int as n from orders where status = 'awaiting_payment' and payment_method = 'eft' and created_at < now() - interval '48 hours'`);
  assert.ok(due >= 1);
  const runs = await Promise.all([1, 2, 3].map(() => jobs.expireUnpaidOrders({ trigger: "test" })));
  assert.equal(runs.reduce((s, r) => s + r.expired, 0), due, "each due order cancelled exactly once across concurrent runs");
  await jobs.expireUnpaidOrders({ trigger: "test" }); // and again later: nothing to do
  const row = await one(`select status, cancelled_at from orders where id = $1`, [old.id]);
  assert.equal(row.status, "cancelled");
  assert.equal(await count(`select count(*)::int as n from refunds where order_id = $1`, [old.id]), 1);
  const refund = await one(`select source, external_id, order_was_paid, amount from refunds where order_id = $1`, [old.id]);
  assert.deepEqual([refund.source, refund.external_id, refund.order_was_paid, Number(refund.amount)], ["system", `expiry:${old.id}`, false, 0]);
  assert.deepEqual(await stockOf(product.id), { stock: baseline.stock, reserved: baseline.reserved + 1 }, "only the expired order's 2 bottles released");
  assert.equal((await one(`select status from orders where id = $1`, [recent.id])).status, "awaiting_payment", "a recent order keeps its reservation");
  assert.equal(await count(`select count(*)::int as n from audit_logs where action = 'order_cancelled' and entity_id = $1 and actor_id = 'system:reservation-expiry'`, [old.order_number]), 1);
  // Paying an expired order is refused, not silently ignored.
  const late = await markPaid(old.id);
  assert.equal(late.status, 409);
  assert.equal((await one(`select status from orders where id = $1`, [old.id])).status, "cancelled");
});

test("E3. expiry racing payment confirmation: each order ends paid or cancelled — never both, stock exact", { skip }, async () => {
  const product = await makeProduct(50);
  const baseline = await stockOf(product.id);
  const placed = [];
  for (let i = 0; i < 12; i++) placed.push(await placeOrder(product.id, 2));
  await sql(`update orders set created_at = now() - interval '72 hours' where id = any($1)`, [placed.map((o) => o.id)]);
  const [payments] = await Promise.all([
    Promise.all(placed.map((o) => markPaid(o.id))),
    jobs.expireUnpaidOrders({ trigger: "test" }),
    jobs.expireUnpaidOrders({ trigger: "test" }),
  ]);
  let paid = 0;
  for (const [i, o] of placed.entries()) {
    const row = await one(`select status from orders where id = $1`, [o.id]);
    const refunds = await count(`select count(*)::int as n from refunds where order_id = $1`, [o.id]);
    if (row.status === "paid") {
      paid++;
      assert.equal(payments[i]!.status, 200);
      assert.equal(refunds, 0, `${o.order_number}: paid orders are never cancelled`);
    } else {
      assert.equal(row.status, "cancelled", `${o.order_number}: unexpected status ${row.status}`);
      assert.equal(payments[i]!.status, 409, `${o.order_number}: payment on an expired order is refused`);
      assert.equal(refunds, 1);
      assert.equal(await count(`select count(*)::int as n from commission_ledger where order_id = $1`, [o.id]), 0);
    }
  }
  assert.deepEqual(await stockOf(product.id), { stock: baseline.stock - paid * 2, reserved: baseline.reserved }, `${paid} paid, ${12 - paid} expired`);
});

// ================================================================ 5. database timeouts

test("T1. lock contention: a request blocked by a held lock gets a controlled 503, then the retry succeeds", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id);
  const blocker = await D.pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select id from orders where id = $1 for update", [order.id]);
    const started = Date.now();
    const blocked = await markPaid(order.id);
    assert.equal(blocked.status, 503);
    assert.ok(Date.now() - started < 6000, "gave up after the lock timeout instead of hanging");
    assert.match(blocked.body.error, /nothing was changed/);
    await blocker.query("rollback");
  } finally {
    blocker.release();
  }
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment");
  assert.equal((await markPaid(order.id)).status, 200, "succeeds once the lock is released");
});

test("T2. a statement that runs too long is cancelled; the transaction rolls back cleanly and later requests work", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id);
  const before = await stockOf(product.id);
  await sql(`create or replace function ops_test_slow() returns trigger language plpgsql as $$ begin perform pg_sleep(3); return new; end $$`);
  await sql(`create trigger ops_test_slow before insert on audit_logs for each row when (new.action = 'order_paid') execute function ops_test_slow()`);
  let slow;
  try {
    slow = await markPaid(order.id);
  } finally {
    await sql(`drop trigger if exists ops_test_slow on audit_logs`);
    await sql(`drop function if exists ops_test_slow()`);
  }
  assert.equal(slow.status, 503);
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment", "rolled back");
  assert.deepEqual(await stockOf(product.id), before);
  assert.equal(await count(`select count(*)::int as n from commission_ledger where order_id = $1`, [order.id]), 0);
  assert.equal((await markPaid(order.id)).status, 200);
});

test("T3. an abandoned transaction is ended by the server; its connection is discarded and the pool recovers", { skip }, async () => {
  const outcome = await D.db
    .transaction(async (tx) => {
      await tx.execute(O.sql`select 1`);
      await sleep(2500); // longer than the idle-in-transaction timeout (1.5 s)
      await tx.execute(O.sql`select 1`);
    })
    .then(() => "committed", (err) => err);
  assert.notEqual(outcome, "committed");
  const { databaseUnavailable } = await import("../lib/http");
  assert.ok(databaseUnavailable(outcome), `recognised as a database timeout/connection loss: ${outcome}`);
  // Every pooled connection still works.
  const results = await Promise.all(Array.from({ length: 15 }, () => D.db.execute(O.sql`select 1 as ok`)));
  assert.equal(results.length, 15);
  assert.equal((await call("GET", "/admin/orders", { email: ADMIN })).status, 200);
});

test("T4. pool exhausted: requests fail fast with 503 instead of hanging, and recover when connections free up", { skip }, async () => {
  const held = [];
  for (let i = 0; i < 10; i++) held.push(await D.pool.connect()); // pg's default pool size
  try {
    const started = Date.now();
    const res = await call("GET", "/admin/orders", { email: ADMIN });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - started < 6000);
  } finally {
    for (const c of held) c.release();
  }
  assert.equal((await call("GET", "/admin/orders", { email: ADMIN })).status, 200);
});

// ================================================================ 6. quarantined payment administration

async function quarantined() {
  const product = await makeProduct(20);
  const order = await placeOrder(product.id);
  await sql(`update orders set payment_method = 'shopify' where id = $1`, [order.id]);
  const res = await hook(payment(order, { total_price: "1.00", total_price_set: { shop_money: { amount: "1.00", currency_code: "ZAR" } } }));
  assert.deepEqual([res.status, res.body.reason], [200, "underpayment"]);
  const event = await one(`select * from payment_events where order_id = $1 order by id desc limit 1`, [order.id]);
  return { order, event };
}

test("Q1. quarantined payments are for administrators only: every operation refuses anyone else", { skip }, async () => {
  const { event } = await quarantined();
  const ops: Array<[string, string, unknown?]> = [
    ["GET", "/admin/payment-events"],
    ["GET", `/admin/payment-events/${event.id}`],
    ["POST", `/admin/payment-events/${event.id}/resolve`, { action: "no_action_required", reason: "unauthorised attempt" }],
    ["GET", "/admin/diagnostics/client-ip"],
  ];
  for (const [method, path, body] of ops) {
    assert.equal((await call(method, path, { body })).status, 401, `${method} ${path} anonymous`);
    for (const email of [CUSTOMER, RESELLER]) assert.equal((await call(method, path, { email, body })).status, 403, `${method} ${path} as ${email}`);
  }
  assert.equal((await one(`select resolved_at from payment_events where id = $1`, [event.id])).resolved_at, null, "nothing was resolved");
});

test("Q2. listing, filters and investigation show what reconciliation needs — no customer contact details", { skip }, async () => {
  const { order, event } = await quarantined();
  const other = await quarantined();
  await hook(payment(other.order, { currency: "USD", total_price_set: { shop_money: { amount: Number(other.order.total).toFixed(2), currency_code: "USD" } } }));

  const open = await call("GET", "/admin/payment-events", { email: ADMIN });
  assert.equal(open.status, 200);
  const row = open.body.find((e: { id: number }) => e.id === event.id);
  assert.ok(row, "listed while awaiting review");
  assert.deepEqual([row.review, row.reason, row.amount, row.expectedAmount, row.order.orderNumber], ["open", "underpayment", 1, Number(order.total), order.order_number]);
  assert.equal(row.difference, Number((1 - Number(order.total)).toFixed(2)));
  for (const secret of [order.customer_email, order.customer_mobile, order.address_line1, SECRET]) assert.ok(!open.text.includes(secret), `does not expose ${secret}`);

  const byReason = await call("GET", "/admin/payment-events?reason=currency_mismatch", { email: ADMIN });
  assert.ok(byReason.body.length >= 1 && byReason.body.every((e: { reason: string }) => e.reason === "currency_mismatch"));
  const bySearch = await call("GET", `/admin/payment-events?q=${encodeURIComponent(order.order_number)}`, { email: ADMIN });
  assert.deepEqual(bySearch.body.map((e: { id: number }) => e.id), [event.id]);
  const all = await call("GET", "/admin/payment-events?review=all", { email: ADMIN });
  assert.ok(all.body.length >= open.body.length);

  const detail = await call("GET", `/admin/payment-events/${other.event.id}`, { email: ADMIN });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.related.length, 1, "the order's other payment notification is shown");
  assert.ok(!detail.text.includes(other.order.customer_email));
});

test("Q3. resolution: reason required, never marks paid, audited with actor/time/original status, once only", { skip }, async () => {
  const { order, event } = await quarantined();
  const resolve = (body: unknown) => call("POST", `/admin/payment-events/${event.id}/resolve`, { email: ADMIN, body });
  assert.equal((await resolve({ action: "refunded_in_shopify" })).status, 400, "reason required");
  assert.equal((await resolve({ action: "refunded_in_shopify", reason: "ok" })).status, 400, "reason too short");
  assert.equal((await resolve({ action: "pay_it", reason: "make it paid please" })).status, 400, "unknown action");
  const premature = await resolve({ action: "confirmed_order_paid", reason: "customer says they paid" });
  assert.equal(premature.status, 400, "cannot claim the order was paid while it is not");
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment");

  // Two administrators at once: one resolution wins.
  const [a, b] = await Promise.all([
    resolve({ action: "refunded_in_shopify", reason: "Refunded R1.00 in Shopify, customer re-ordering" }),
    resolve({ action: "no_action_required", reason: "Duplicate review attempt" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? a : b;
  assert.deepEqual([winner.body.review, winner.body.resolution.orderStatusAtResolution], ["resolved", "awaiting_payment"]);

  const stored = await one(`select * from payment_events where id = $1`, [event.id]);
  const admin = await one(`select id from users where email = $1`, [ADMIN]);
  assert.equal(stored.resolved_by, admin.id);
  assert.ok(stored.resolved_at);
  assert.equal(stored.outcome, "rejected", "the original outcome is kept");
  const audits = (await sql(`select * from audit_logs where action = 'payment_event_resolved' and entity_id = $1`, [String(event.id)])).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, `user:${admin.id}`);
  const meta = JSON.parse(audits[0].metadata);
  assert.deepEqual([meta.action, meta.originalOutcome, meta.originalReason, meta.orderStatus, meta.orderNumber], [stored.resolution_action, "rejected", "underpayment", "awaiting_payment", order.order_number]);
  assert.ok(meta.reason.length >= 5);
  // Nothing about the order changed.
  const after = await one(`select status, paid_at from orders where id = $1`, [order.id]);
  assert.deepEqual([after.status, after.paid_at], ["awaiting_payment", null]);
  assert.equal(await count(`select count(*)::int as n from commission_ledger where order_id = $1`, [order.id]), 0);
  assert.equal((await resolve({ action: "other", reason: "trying again later" })).status, 409, "resolved once");
  const detail = await call("GET", `/admin/payment-events/${event.id}`, { email: ADMIN });
  assert.equal(detail.body.history.length, 1);
  assert.equal((await call("GET", "/admin/payment-events", { email: ADMIN })).body.some((e: { id: number }) => e.id === event.id), false, "no longer awaiting review");
});

test("Q4. 'confirmed — order marked paid' is accepted only after the order was marked paid through Orders", { skip }, async () => {
  const { order, event } = await quarantined();
  assert.equal((await markPaid(order.id)).status, 200);
  const res = await call("POST", `/admin/payment-events/${event.id}/resolve`, { email: ADMIN, body: { action: "confirmed_order_paid", reason: "Bank statement shows full EFT on 9 Oct" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.resolution.orderStatusAtResolution, "paid");
  // An applied payment is not something to resolve.
  const product = await makeProduct(5);
  const good = await placeOrder(product.id);
  await sql(`update orders set payment_method = 'shopify' where id = $1`, [good.id]);
  assert.equal((await hook(payment(good))).body.outcome, "applied");
  const applied = await one(`select id from payment_events where order_id = $1`, [good.id]);
  assert.equal((await call("POST", `/admin/payment-events/${applied.id}/resolve`, { email: ADMIN, body: { action: "other", reason: "not quarantined at all" } })).status, 400);
});
