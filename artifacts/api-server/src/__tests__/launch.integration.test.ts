/**
 * Launch safety (Phase 5), against the real code on a DISPOSABLE local
 * database (TEST_LAUNCH_DATABASE_URL, migrations applied, NO environment
 * marker yet — the demo network is seeded into it). Shopify is simulated: the
 * Storefront API is answered by a stub in this process and webhooks are
 * synthetic payloads signed with a test secret.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { API_DIR, childEnv, freePort, startEntry, testDatabaseUrl } from "./helpers";

const url = testDatabaseUrl("TEST_LAUNCH_DATABASE_URL");
const skip = url ? false : "TEST_LAUNCH_DATABASE_URL not set";
const SECRET = "launch-test-secret";
const SHOP = "launch-shop.myshopify.com";

for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "DISABLE_DEMO_AUTH", "ADMIN_EMAILS", "DEMO_AUTH", "SEED_DEMO_DATA", "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_TOKEN", "REPLIT_CONNECTORS_HOSTNAME", "TRUSTED_PROXY_HOPS", "DEPLOY_ENVIRONMENT"]) delete process.env[key];
Object.assign(process.env, { NODE_ENV: "test", LOG_LEVEL: "silent", SHOPIFY_WEBHOOK_SECRET: SECRET, DB_STATEMENT_TIMEOUT_MS: "2000", DB_LOCK_TIMEOUT_MS: "1500", DB_CONNECTION_TIMEOUT_MS: "2000" });
if (url) process.env.DATABASE_URL = url;

// Storefront API stub: variant prices by id (set per test).
const realFetch = globalThis.fetch;
let variantPrices = new Map<string, { amount: string; currencyCode: string }>();
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (target.includes(SHOP)) {
    const { variables } = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
    const nodes = variables.ids.map((id) => (variantPrices.has(id) ? { id, availableForSale: true, price: variantPrices.get(id)! } : null));
    return Response.json({ data: { nodes } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const ADMIN = "admin@masmila.co.za";
let server: Server;
let base = "";
let app: typeof import("../app").default;
let D: typeof import("@workspace/db");
let O: typeof import("drizzle-orm");
let orders: typeof import("../lib/orders");
let jobs: typeof import("../lib/jobs");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function call(method: string, path: string, o: { email?: string; body?: unknown; headers?: Record<string, string>; raw?: string; base?: string } = {}) {
  const response = await realFetch((o.base ?? base) + path, {
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

async function burst(endpoint: string, count: number, headers: (i: number) => Record<string, string>, bases: string[] = [base]) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) statuses.push((await call("POST", endpoint, { headers: headers(i), body: {}, base: bases[i % bases.length] })).status);
  return { allowed: statuses.filter((s) => s !== 429).length, limited: statuses.filter((s) => s === 429).length };
}

let seq = 0;
async function makeProduct(stock: number, extra: { shopifyVariantId?: string; retailPrice?: number } = {}) {
  const tag = randomUUID().slice(0, 8);
  const [p] = await D.db
    .insert(D.productsTable)
    .values({ slug: `launch-${tag}`, sku: `LCH-${tag}`, name: `Launch test ${++seq}`, category: "Unisex", family: "Fresh", size: "50ml", retailPrice: extra.retailPrice ?? 299, recommendedRetailPrice: 299, resellerPrice: 140, cost: 50, stockQuantity: stock, shopifyVariantId: extra.shopifyVariantId ?? null })
    .returning();
  return p!;
}
async function placeOrder(productId: number, method: "eft" | "shopify" = "eft") {
  const { orderId } = await orders.createOrder(
    { mode: "retail", items: [{ productId, quantity: 1 }], customer: { firstName: "Launch", surname: "Tester", email: `l-${randomUUID().slice(0, 8)}@launch.test`, mobile: "0820000000" }, address: { line1: "1 Launch Lane", city: "Durban", province: "KwaZulu-Natal", postalCode: "4001" }, paymentMethod: "eft" },
    { user: null, reseller: null },
  );
  if (method === "shopify") await sql(`update orders set payment_method = 'shopify' where id = $1`, [orderId]);
  return one(`select * from orders where id = $1`, [orderId]);
}
function paidHook(order: { order_number: string; total: string | number }, over: Record<string, unknown> = {}) {
  const amount = Number(order.total).toFixed(2);
  const id = 9_500_000 + ++seq;
  const raw = JSON.stringify({ id, name: `#${id}`, financial_status: "paid", currency: "ZAR", total_price: amount, total_price_set: { shop_money: { amount, currency_code: "ZAR" } }, total_outstanding: "0.00", test: false, cancelled_at: null, note_attributes: [{ name: "masmila_order", value: order.order_number }], ...over });
  return call("POST", "/webhooks/shopify", { raw, headers: { "x-shopify-topic": "orders/paid", "x-shopify-webhook-id": randomUUID(), "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(raw).digest("base64") } });
}

before(async () => {
  if (skip) return;
  D = await import("@workspace/db");
  O = await import("drizzle-orm");
  orders = await import("../lib/orders");
  jobs = await import("../lib/jobs");
  const { prepareData } = await import("../lib/prepare");
  app = (await import("../app")).default;
  await prepareData();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => {
  if (skip) return;
  server?.close();
  await D?.pool.end();
});

// ================================================================ rate limiting

test("L1. spoofed forwarding headers cannot escape the shared rate limit (direct, one trusted proxy)", { skip }, async () => {
  // Direct (default): every request claims another address — all count as this one client.
  assert.deepEqual(await burst("/enquiries", 25, (i) => ({ "x-forwarded-for": `203.0.113.${i + 1}` })), { allowed: 20, limited: 5 });
  // Behind one trusted proxy: rotating the client-written part changes nothing; another real client has its own allowance.
  app.set("trust proxy", 1);
  try {
    assert.deepEqual(await burst("/orders/track", 25, (i) => ({ "x-forwarded-for": `198.51.100.${i + 1}, 192.0.2.10` })), { allowed: 20, limited: 5 });
    assert.deepEqual(await burst("/orders/track", 1, () => ({ "x-forwarded-for": "192.0.2.11" })), { allowed: 1, limited: 0 });
  } finally {
    app.set("trust proxy", 0);
  }
  const stored = (await sql(`select bucket from rate_limits`)).rows.map((r) => r.bucket as string);
  assert.ok(stored.length >= 3);
  assert.ok(stored.every((b) => /^[0-9a-f]{40}$/.test(b)), "only hashes are stored, never addresses");
});

test("L2. Netlify: the address Netlify reports decides; X-Forwarded-For is ignored", { skip }, async () => {
  const ip = await import("../lib/client-ip");
  ip.useClientIpSource("netlify");
  try {
    assert.deepEqual(await burst("/newsletter", 25, (i) => ({ "x-nf-client-connection-ip": "192.0.2.50", "x-forwarded-for": `203.0.113.${i + 1}` })), { allowed: 20, limited: 5 });
    assert.deepEqual(await burst("/newsletter", 3, () => ({ "x-nf-client-connection-ip": "192.0.2.51" })), { allowed: 3, limited: 0 });
  } finally {
    ip.useClientIpSource("socket");
  }
});

test("L3. two server instances share one allowance (no multiplying the limit by scaling out)", { skip }, async () => {
  const port = await freePort();
  const { child } = await startEntry("src/index.ts", childEnv({ NODE_ENV: "test", LOG_LEVEL: "info", DATABASE_URL: url!, PORT: String(port), SEED_DEMO_DATA: "false" }), "Server listening");
  try {
    const second = `http://127.0.0.1:${port}/api`;
    // Alternate between the two instances, same client.
    const r = await burst("/reseller-applications", 24, () => ({}), [base, second]);
    assert.deepEqual(r, { allowed: 20, limited: 4 });
  } finally {
    child.kill();
  }
});

// ================================================================ database timeouts and outage

test("L4. a statement outside any transaction is also cut off by the statement timeout", { skip }, async () => {
  const started = Date.now();
  const err = await D.db.execute(O.sql`select pg_sleep(3)`).then(() => null, (e: unknown) => e);
  assert.ok(err, "the 3 s statement must not complete under a 2 s limit");
  const { databaseUnavailable } = await import("../lib/http");
  assert.equal(databaseUnavailable(err), "timeout");
  assert.ok(Date.now() - started < 2900);
  assert.equal((await D.db.execute(O.sql`select 1 as ok`)).rows.length, 1, "the connection is usable afterwards");
});

test("L5. database temporarily unavailable: requests get 503, nothing half-written, service recovers", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id);
  const dbName = new URL(url!).pathname.slice(1);
  // A separate maintenance connection (same driver as the app's pool) to the server's "postgres" database.
  const Pool = D.pool.constructor as new (config: { connectionString: string; max: number }) => typeof D.pool;
  const admin = new Pool({ connectionString: url!.replace(`/${dbName}`, "/postgres"), max: 1 });
  try {
    await admin.query(`alter database "${dbName}" with allow_connections false`);
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [dbName]);
    await sleep(200);
    const during = await call("PATCH", `/admin/orders/${order.id}`, { email: ADMIN, body: { status: "paid" } });
    assert.equal(during.status, 503, during.text);
    assert.equal((await call("GET", "/products")).status, 503);
  } finally {
    await admin.query(`alter database "${dbName}" with allow_connections true`);
    await admin.end();
  }
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment", "nothing applied during the outage");
  const after = await call("PATCH", `/admin/orders/${order.id}`, { email: ADMIN, body: { status: "paid" } });
  assert.equal(after.status, 200, "recovered without a restart");
  assert.equal((await call("GET", "/products")).status, 200);
});

// ================================================================ environment isolation and preflight

test("L6. environment guard: a deployment refuses a database marked for another environment", { skip }, async () => {
  const { databaseEnvironmentErrors } = await import("../lib/environment-guard");
  const prod = { NODE_ENV: "production", DEPLOY_ENVIRONMENT: "production" };
  assert.match((await databaseEnvironmentErrors(prod)).join(), /no environment marker/);
  await sql(`insert into deployment_marker (id, environment, marked_by) values (1, 'production', 'test')`);
  try {
    assert.deepEqual(await databaseEnvironmentErrors(prod), []);
    assert.match((await databaseEnvironmentErrors({ NODE_ENV: "production", DEPLOY_ENVIRONMENT: "staging" })).join(), /staging deployment is connected to the production database/);
    // A Netlify deploy preview is staging, whatever DEPLOY_ENVIRONMENT says.
    assert.match((await databaseEnvironmentErrors({ NODE_ENV: "production", NETLIFY_DEPLOY_CONTEXT: "deploy-preview", DEPLOY_ENVIRONMENT: "production" })).join(), /staging deployment/);
    assert.deepEqual(await databaseEnvironmentErrors({ NODE_ENV: "test" }), [], "not enforced in development/test");
  } finally {
    await sql(`delete from deployment_marker`);
  }
});

test("L7. migration runner marks a database once and refuses to re-mark it as another environment", { skip }, async () => {
  const runner = path.resolve(API_DIR, "..", "..", "lib", "db", "scripts", "migrate.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [runner, ...args], { env: { ...process.env, DATABASE_URL: url! }, encoding: "utf8" });
  const dry = run("--environment", "staging");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal((await sql(`select count(*)::int as n from deployment_marker`)).rows[0].n, 0, "a dry run marks nothing");
  const mark = run("--apply", "--environment", "staging");
  assert.equal(mark.status, 0, mark.stderr);
  assert.match(mark.stdout, /marked this database as staging/);
  const remark = run("--apply", "--environment", "production");
  assert.notEqual(remark.status, 0);
  assert.match(remark.stderr, /marked "staging", not "production"/);
  assert.equal((await one(`select environment from deployment_marker`)).environment, "staging");
  await sql(`delete from deployment_marker`);
});

test("L8. preflight reports configuration, migrations, environment, demo data and Shopify price drift — without secrets", { skip }, async () => {
  const { runPreflight } = await import("../lib/preflight");
  const matching = await makeProduct(5, { shopifyVariantId: "gid://shopify/ProductVariant/7001", retailPrice: 299 });
  const drifted = await makeProduct(5, { shopifyVariantId: "7002", retailPrice: 450 });
  variantPrices = new Map([
    ["gid://shopify/ProductVariant/7001", { amount: "299.00", currencyCode: "ZAR" }],
    ["gid://shopify/ProductVariant/7002", { amount: "399.00", currencyCode: "ZAR" }],
  ]);
  Object.assign(process.env, { SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_STOREFRONT_TOKEN: "fake-token" });
  await sql(`insert into deployment_marker (id, environment, marked_by) values (1, 'staging', 'test')`);
  try {
    const env = {
      ...process.env,
      NODE_ENV: "production",
      DEPLOY_ENVIRONMENT: "staging",
      CLERK_SECRET_KEY: "sk_test_SECRETVALUEDONOTPRINT",
      CLERK_PUBLISHABLE_KEY: "pk_test_ZmFrZS5leGFtcGxlLmNvbSQ",
      SITE_URL: "https://staging.example",
      ADMIN_EMAILS: "owner@example.com",
    };
    const checks = await runPreflight(env);
    const get = (name: string) => checks.find((c) => c.name === name);
    assert.equal(get("deployment environment")?.status, "pass");
    assert.equal(get("migrations")?.status, "pass", get("migrations")?.detail);
    assert.equal(get("environment marker")?.status, "pass", get("environment marker")?.detail);
    assert.equal(get("demo data")?.status, "fail", "this test database was seeded with demo accounts");
    const prices = get("Shopify prices")!;
    assert.equal(prices.status, "fail");
    assert.match(prices.detail, new RegExp(`${drifted.name} 50ml: Shopify R399.00 vs storefront R450.00`));
    assert.doesNotMatch(prices.detail, new RegExp(matching.name + " "));
    assert.equal(get("SHOPIFY_WEBHOOK_SECRET")?.status, "pass");
    assert.ok(!JSON.stringify(checks).includes("SECRETVALUEDONOTPRINT") && !JSON.stringify(checks).includes(SECRET), "no secret values in the report");
    // Wrong environment is caught too.
    const wrong = await runPreflight({ ...env, DEPLOY_ENVIRONMENT: "production", CLERK_SECRET_KEY: "sk_live_X1" });
    assert.equal(wrong.find((c) => c.name === "environment marker")?.status, "fail");
  } finally {
    await sql(`delete from deployment_marker`);
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_STOREFRONT_TOKEN;
  }
});

// ================================================================ payment exceptions and reservations

test("L9. resolving a quarantined payment also closes its fraud flag, in the same audited step", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id, "shopify");
  const hook = await paidHook(order, { total_price: "1.00", total_price_set: { shop_money: { amount: "1.00", currency_code: "ZAR" } } });
  assert.equal(hook.body.reason, "underpayment");
  const event = await one(`select id from payment_events where order_id = $1`, [order.id]);
  const flag = await one(`select * from fraud_flags where payment_event_id = $1`, [event.id]);
  assert.equal(flag.status, "open");
  const res = await call("POST", `/admin/payment-events/${event.id}/resolve`, { email: ADMIN, body: { action: "refunded_in_shopify", reason: "Refunded the R1.00 in Shopify" } });
  assert.equal(res.status, 200);
  const closed = await one(`select status, resolved_at from fraud_flags where id = $1`, [flag.id]);
  assert.equal(closed.status, "resolved");
  assert.ok(closed.resolved_at);
  const audit = await one(`select metadata from audit_logs where action = 'payment_event_resolved' and entity_id = $1`, [String(event.id)]);
  assert.deepEqual(JSON.parse(audit.metadata).fraudFlagsResolved, [flag.id]);
});

test("L10. abandoned Shopify checkouts expire only when enabled; a later Shopify payment is quarantined", { skip }, async () => {
  const product = await makeProduct(10);
  const shopifyOrder = await placeOrder(product.id, "shopify");
  const eftOrder = await placeOrder(product.id, "eft");
  await sql(`update orders set created_at = now() - interval '30 hours' where id = any($1)`, [[shopifyOrder.id, eftOrder.id]]);
  assert.equal((await jobs.expireUnpaidOrders({ trigger: "test" })).enabled, false, "off by default");
  assert.equal((await call("PATCH", "/admin/settings", { email: ADMIN, body: { shopifyReservationHours: 24 } })).status, 200);
  try {
    const run = await jobs.expireUnpaidOrders({ trigger: "test" });
    assert.deepEqual([run.hours.shopify, run.hours.eft], [24, null]);
    assert.equal((await one(`select status from orders where id = $1`, [shopifyOrder.id])).status, "cancelled");
    assert.equal((await one(`select status from orders where id = $1`, [eftOrder.id])).status, "awaiting_payment", "EFT expiry is a separate decision (still off)");
    const late = await paidHook(shopifyOrder);
    assert.deepEqual([late.status, late.body.outcome, late.body.reason], [200, "rejected", "order_cancelled"]);
  } finally {
    await call("PATCH", "/admin/settings", { email: ADMIN, body: { shopifyReservationHours: null } });
  }
});

test("L11. maintenance mode stops every write (webhooks included) without touching data, and lifts cleanly", { skip }, async () => {
  const product = await makeProduct(5);
  const order = await placeOrder(product.id, "shopify");
  process.env.MAINTENANCE_MODE = "true";
  try {
    assert.equal((await call("GET", "/healthz")).status, 200, "health check still answers");
    const checkout = await call("POST", "/checkout", { body: {} });
    assert.equal(checkout.status, 503);
    assert.match(checkout.body.error, /maintenance/);
    assert.equal((await call("PATCH", `/admin/orders/${order.id}`, { email: ADMIN, body: { status: "paid" } })).status, 503);
    const hook = await paidHook(order);
    assert.equal(hook.status, 503, "Shopify will retry the webhook later");
    assert.equal((await one(`select count(*)::int as n from payment_events where order_id = $1`, [order.id])).n, 0, "nothing recorded");
  } finally {
    delete process.env.MAINTENANCE_MODE;
  }
  assert.equal((await one(`select status from orders where id = $1`, [order.id])).status, "awaiting_payment");
  const retried = await paidHook(order);
  assert.equal(retried.body.outcome, "applied", "the retried webhook is processed after maintenance");
});

test("L12. staging evidence report: read-only, no customer contact details, synthetic deliveries marked unverified", { skip }, async () => {
  const { stagingEvidence } = await import("../lib/staging-evidence");
  const product = await makeProduct(5);
  const order = await placeOrder(product.id, "shopify");
  // A synthetic signed payload without Shopify's store/API headers — what the local suites send.
  assert.equal((await paidHook(order)).body.outcome, "applied");
  const before = await one(`select (select count(*) from audit_logs)::int as audits, (select count(*) from payment_events)::int as events`);
  const report = await stagingEvidence({ order: order.order_number, limit: 50 });
  for (const section of ["Database", "Migrations applied", "Payment notifications", "Refunds and cancellations", `Incentive ledger for ${order.order_number}`, `Stock for ${order.order_number}`, "Payouts", "Month-end runs", "Job executions", "Queues", "Audit log"]) {
    assert.ok(report.includes(`### ${section}`), `has section ${section}`);
  }
  const line = report.split("\n").find((l) => l.includes(order.order_number) && l.includes("orders/paid"));
  assert.ok(line, "the payment appears");
  assert.match(line!, /\| unverified \|/, "a payload without Shopify's provenance headers is not provider evidence");
  assert.ok(!/@launch\.test|0820000000|Launch Lane/.test(report), "no customer contact details");
  assert.ok(!report.includes(SECRET));
  const after = await one(`select (select count(*) from audit_logs)::int as audits, (select count(*) from payment_events)::int as events`);
  assert.deepEqual(after, before, "read-only");
});
