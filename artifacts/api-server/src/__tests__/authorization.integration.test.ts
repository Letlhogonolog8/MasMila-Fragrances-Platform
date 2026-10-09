/**
 * Server-side authorization, exercised over HTTP against the real Express app
 * and a throwaway LOCAL database (TEST_DATABASE_URL, schema applied; the demo
 * network is seeded into it). Identities are supplied with the test-only demo
 * tokens, which exist solely because NODE_ENV=test here — production refuses
 * them (see startup.integration.test.ts).
 *
 * Protected routes are discovered from the route files, so a new admin,
 * reseller or account route is covered automatically.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { testDatabaseUrl } from "./helpers";

const url = testDatabaseUrl("TEST_DATABASE_URL");
const skip = url ? false : "TEST_DATABASE_URL not set";

for (const key of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "DISABLE_DEMO_AUTH", "ADMIN_EMAILS", "DEMO_AUTH", "SEED_DEMO_DATA"]) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
if (url) process.env.DATABASE_URL = url;

const ADMIN = "admin@masmila.co.za";
const MANAGER = "manager@masmila.co.za";
const TEAM_LEADER = "teamleader@masmila.co.za"; // Nomdade
const OTHER_TEAM_LEADER = "sipho@masmila.co.za";
const RESELLER = "reseller@masmila.co.za"; // Ayanda, in Nomdade's team
const OTHER_RESELLER = "bongani@masmila.co.za"; // also in Nomdade's team
const CUSTOMER = "customer@masmila.co.za";

type Route = { method: string; path: string };

/** Routes declared in a route file; `filter` sees the rest of the declaring line. */
function routesIn(file: string, filter: (line: string, path: string) => boolean = () => true): Route[] {
  const source = readFileSync(path.resolve(import.meta.dirname, "..", "routes", file), "utf8");
  const routes: Route[] = [];
  for (const m of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"([^\n]*)/g)) {
    if (filter(m[3]!, m[2]!)) routes.push({ method: m[1]!.toUpperCase(), path: m[2]!.replace(/:[A-Za-z]+/g, "1") });
  }
  return routes;
}

const ADMIN_ROUTES = routesIn("admin.ts");
const RESELLER_ROUTES = routesIn("reseller.ts");
const ACCOUNT_ROUTES = routesIn("account.ts", (line) => line.includes("requireUser"));

let server: Server;
let base = "";
let db: typeof import("@workspace/db");
let drizzle: typeof import("drizzle-orm");

type Call = { email?: string; headers?: Record<string, string>; body?: unknown; query?: string };
async function call(method: string, routePath: string, o: Call = {}) {
  const response = await fetch(`${base}${routePath}${o.query ?? ""}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(o.email ? { authorization: `Bearer demo:${o.email}` } : {}),
      ...o.headers,
    },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(o.body ?? {}),
  });
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    /* non-JSON (e.g. CSV) */
  }
  return { status: response.status, body: json };
}

async function resellerOf(email: string) {
  const { eq } = drizzle;
  const [row] = await db.db
    .select({ reseller: db.resellersTable })
    .from(db.resellersTable)
    .innerJoin(db.usersTable, eq(db.usersTable.id, db.resellersTable.userId))
    .where(eq(db.usersTable.email, email));
  assert.ok(row, `seeded reseller ${email} missing`);
  return row.reseller;
}

before(async () => {
  if (skip) return;
  db = await import("@workspace/db");
  drizzle = await import("drizzle-orm");
  const { prepareData } = await import("../lib/prepare");
  const { default: app } = await import("../app");
  await prepareData(); // seeds the demo network on first run (test environment only)
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(async () => {
  if (skip) return;
  server?.close();
  await db?.pool.end();
});

test("route discovery found the protected surface", { skip }, () => {
  // Lower bounds from the current route files (35 admin, 6 reseller, 7 guarded account) — guards against a broken matcher.
  assert.ok(ADMIN_ROUTES.length >= 35, `admin routes: ${ADMIN_ROUTES.length}`);
  assert.ok(RESELLER_ROUTES.length >= 6, `reseller routes: ${RESELLER_ROUTES.length}`);
  assert.ok(ACCOUNT_ROUTES.length >= 6, `account routes: ${ACCOUNT_ROUTES.length}`);
  assert.ok(ADMIN_ROUTES.every((r) => r.path.startsWith("/admin")));
  assert.ok(RESELLER_ROUTES.every((r) => r.path.startsWith("/reseller") || r.path.startsWith("/marketing-materials")));
});

test("unauthenticated requests to every protected route get 401", { skip }, async () => {
  const failures: string[] = [];
  for (const r of [...ADMIN_ROUTES, ...RESELLER_ROUTES, ...ACCOUNT_ROUTES]) {
    const { status } = await call(r.method, r.path);
    if (status !== 401) failures.push(`${r.method} ${r.path} → ${status}`);
  }
  assert.deepEqual(failures, []);
});

test("malformed or foreign tokens are treated as unauthenticated (401, never 500)", { skip }, async () => {
  const tokens = ["Bearer demo:not-an-email", "Bearer demo:%E0%A4%A", "Bearer eyJhbGciOiJIUzI1NiJ9.e30.fake", "Basic YWRtaW46YWRtaW4=", "Bearer demo:"];
  for (const authorization of tokens) {
    assert.equal((await call("GET", "/admin/summary", { headers: { authorization } })).status, 401, authorization);
    const me = await call("GET", "/me", { headers: { authorization } });
    assert.equal(me.status, 200, authorization);
    assert.equal(me.body.signedIn, false, authorization);
  }
});

for (const [who, email] of [["customer", CUSTOMER], ["reseller", RESELLER], ["team leader", TEAM_LEADER], ["manager", MANAGER]] as const) {
  test(`${who} gets 403 on every admin route`, { skip }, async () => {
    const failures: string[] = [];
    for (const r of ADMIN_ROUTES) {
      const { status } = await call(r.method, r.path, { email });
      if (status !== 403) failures.push(`${r.method} ${r.path} → ${status}`);
    }
    assert.deepEqual(failures, []);
  });
}

test("customer gets 403 on every reseller route", { skip }, async () => {
  const failures: string[] = [];
  for (const r of RESELLER_ROUTES) {
    const { status } = await call(r.method, r.path, { email: CUSTOMER });
    if (status !== 403) failures.push(`${r.method} ${r.path} → ${status}`);
  }
  assert.deepEqual(failures, []);
});

test("Team Leader and Reseller cannot open the Manager organisation view", { skip }, async () => {
  assert.equal((await call("GET", "/reseller/organisation", { email: TEAM_LEADER })).status, 403);
  assert.equal((await call("GET", "/reseller/organisation", { email: RESELLER })).status, 403);
});

test("rejected admin actions have no side effects", { skip }, async () => {
  const { eq, sql } = drizzle;
  const victim = await resellerOf(OTHER_RESELLER);
  const payoutsBefore = (await db.db.select({ n: sql<number>`count(*)::int` }).from(db.payoutsTable))[0]!.n;
  assert.equal((await call("PATCH", `/admin/resellers/${victim.id}`, { email: RESELLER, body: { standing: "suspended", rank: "director" } })).status, 403);
  assert.equal((await call("POST", "/admin/payouts", { email: RESELLER, body: {} })).status, 403);
  assert.equal((await call("PATCH", "/admin/settings", { email: MANAGER, body: { teamLeaderRate: 50 } })).status, 403);
  const [after] = await db.db.select().from(db.resellersTable).where(eq(db.resellersTable.id, victim.id));
  assert.equal(after!.standing, victim.standing);
  assert.equal(after!.rank, victim.rank);
  assert.equal((await db.db.select({ n: sql<number>`count(*)::int` }).from(db.payoutsTable))[0]!.n, payoutsBefore);
  const [settings] = await db.db.select().from(db.compensationSettingsTable);
  assert.notEqual(settings!.teamLeaderRate, 50);
});

test("forged client-side admin claims are ignored", { skip }, async () => {
  const forged = { "x-user-role": "admin", "x-role": "admin", "x-admin": "true", "x-is-admin": "true", cookie: "role=admin; isAdmin=true; masmila.demoUser=admin@masmila.co.za" };
  assert.equal((await call("GET", "/admin/summary", { email: CUSTOMER, headers: forged, query: "?role=admin&isAdmin=true" })).status, 403);
  const me = await call("GET", "/me", { email: CUSTOMER, headers: forged });
  assert.equal(me.body.isAdmin, false);
  assert.equal(me.body.user.role, "customer");

  // Profile updates cannot set role, status or email.
  const patched = await call("PATCH", "/me", { email: CUSTOMER, body: { role: "admin", isAdmin: true, accountStatus: "active", email: ADMIN, firstName: "Palesa" } });
  assert.equal(patched.status, 200);
  const { eq } = drizzle;
  const [user] = await db.db.select().from(db.usersTable).where(eq(db.usersTable.email, CUSTOMER));
  assert.equal(user!.role, "customer");
  assert.equal((await call("GET", "/admin/summary", { email: CUSTOMER })).status, 403);
});

test("a reseller sees only their own incentives, whatever ids they send", { skip }, async () => {
  const me = await resellerOf(RESELLER);
  const other = await resellerOf(OTHER_RESELLER);
  const plain = await call("GET", "/reseller/incentives", { email: RESELLER });
  assert.equal(plain.status, 200);
  assert.ok(plain.body.every((r: any) => r.beneficiaryResellerCode === me.resellerCode));
  const tampered = await call("GET", "/reseller/incentives", {
    email: RESELLER,
    query: `?resellerId=${other.id}&beneficiaryResellerId=${other.id}`,
    headers: { "x-reseller-id": String(other.id) },
  });
  assert.deepEqual(tampered.body, plain.body);
  const tl = await resellerOf(TEAM_LEADER);
  const tlRows = await call("GET", "/reseller/incentives", { email: TEAM_LEADER });
  assert.ok(tlRows.body.length > 0, "the seeded Team Leader has incentives to compare against");
  assert.ok(tlRows.body.every((r: any) => r.beneficiaryResellerCode === tl.resellerCode));
});

test("a Team Leader's team view contains only their own direct team", { skip }, async () => {
  const nomdade = await resellerOf(TEAM_LEADER);
  const sipho = await resellerOf(OTHER_TEAM_LEADER);
  const { inArray } = drizzle;
  const team = await call("GET", "/reseller/team", { email: TEAM_LEADER });
  assert.ok(team.body.length > 0);
  const rows = await db.db.select().from(db.resellersTable).where(inArray(db.resellersTable.id, team.body.map((m: any) => m.id)));
  assert.ok(rows.every((r) => r.sponsorId === nomdade.id));
  const siphoTeam = await call("GET", "/reseller/team", { email: OTHER_TEAM_LEADER });
  assert.ok(siphoTeam.body.every((m: any) => !team.body.some((n: any) => n.id === m.id)));
  const siphoRows = await db.db.select().from(db.resellersTable).where(inArray(db.resellersTable.id, siphoTeam.body.map((m: any) => m.id)));
  assert.ok(siphoRows.every((r) => r.sponsorId === sipho.id));
});

test("a reseller's sales list contains only sales attributed to them, with masked customers", { skip }, async () => {
  const nomdade = await resellerOf(TEAM_LEADER);
  const { inArray } = drizzle;
  const sales = await call("GET", "/reseller/sales", { email: TEAM_LEADER });
  assert.ok(sales.body.length > 0, "seeded referral sale expected");
  const orders = await db.db.select().from(db.ordersTable).where(inArray(db.ordersTable.orderNumber, sales.body.map((o: any) => o.orderNumber)));
  assert.ok(orders.every((o) => o.attributedResellerId === nomdade.id));
  assert.ok(sales.body.every((o: any) => o.customerEmail.includes("•••")), "customer email is masked");
  const other = await call("GET", "/reseller/sales", { email: OTHER_RESELLER });
  assert.ok(other.body.every((o: any) => !sales.body.some((s: any) => s.orderNumber === o.orderNumber)));
});

test("a customer's order list contains only their own orders", { skip }, async () => {
  const res = await call("GET", "/me/orders", { email: CUSTOMER });
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0);
  assert.ok(res.body.every((o: any) => o.customerEmail === CUSTOMER));
  const resellerOrders = await call("GET", "/me/orders", { email: RESELLER });
  assert.ok(resellerOrders.body.every((o: any) => !res.body.some((c: any) => c.orderNumber === o.orderNumber)));
});

test("normal access: admin can read every admin GET route", { skip }, async () => {
  const failures: string[] = [];
  for (const r of ADMIN_ROUTES.filter((x) => x.method === "GET")) {
    const { status } = await call("GET", r.path, { email: ADMIN, query: r.path === "/admin/reports" ? "?type=orders" : "" });
    if (status !== 200) failures.push(`GET ${r.path} → ${status}`);
  }
  assert.deepEqual(failures, []);
});

test("normal access: resellers, Team Leaders and Managers reach their portal routes", { skip }, async () => {
  const gets = RESELLER_ROUTES.filter((r) => r.method === "GET");
  for (const email of [RESELLER, TEAM_LEADER, MANAGER]) {
    for (const r of gets) {
      const expected = r.path === "/reseller/organisation" && email !== MANAGER ? 403 : 200;
      assert.equal((await call("GET", r.path, { email })).status, expected, `${email} GET ${r.path}`);
    }
  }
});

test("normal access: a customer reaches every account route", { skip }, async () => {
  for (const r of ACCOUNT_ROUTES.filter((x) => x.method === "GET")) {
    assert.equal((await call("GET", r.path, { email: CUSTOMER })).status, 200, r.path);
  }
  const me = await call("GET", "/me", { email: CUSTOMER });
  assert.deepEqual([me.body.signedIn, me.body.isAdmin, me.body.reseller], [true, false, null]);
});

test("a suspended account is refused on protected routes", { skip }, async () => {
  const { eq } = drizzle;
  const email = "suspended.customer@audit.test";
  assert.equal((await call("GET", "/me", { email })).status, 200); // creates the account
  await db.db.update(db.usersTable).set({ accountStatus: "suspended" }).where(eq(db.usersTable.email, email));
  assert.equal((await call("GET", "/me/orders", { email })).status, 403);
  assert.equal((await call("GET", "/admin/summary", { email })).status, 403);
});

test("account linking never moves an account to a different Clerk user", { skip }, async () => {
  const { upsertUserByEmail } = await import("../lib/auth");
  const email = "link.guard@audit.test";
  const first = await upsertUserByEmail(email, { clerkUserId: "user_original" });
  assert.equal(first?.clerkUserId, "user_original");
  assert.equal(await upsertUserByEmail(email, { clerkUserId: "user_intruder" }), null);
  const again = await upsertUserByEmail(email, { clerkUserId: "user_original" });
  assert.equal(again?.id, first!.id);
  const { eq } = drizzle;
  const [row] = await db.db.select().from(db.usersTable).where(eq(db.usersTable.email, email));
  assert.equal(row!.clerkUserId, "user_original");
});
