/**
 * Production start-up safety: the real entry points (long-running server and
 * Netlify Function) are run in child processes with production-like
 * environments. Failure cases need no database; the "valid configuration"
 * case needs TEST_PROD_DATABASE_URL — an EMPTY local database with the schema
 * applied — and checks that nothing demo-related is created in it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { childEnv, FAKE_CLERK, freePort, NO_DATABASE, runEntry, startEntry, testDatabaseUrl } from "./helpers";

const SERVER = "src/index.ts";
const NETLIFY_PROBE = "src/__tests__/fixtures/netlify-probe.ts";

async function expectRefusal(env: Record<string, string>, mentions: string[]) {
  const result = await runEntry(SERVER, childEnv({ PORT: "0", DATABASE_URL: NO_DATABASE, ...env }));
  assert.equal(result.code, 1, `expected exit code 1, got ${result.code}\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stderr.includes("Refusing to start"), result.stderr);
  for (const text of mentions) assert.ok(result.stderr.includes(text), `stderr should mention ${text}:\n${result.stderr}`);
  assert.ok(!result.stdout.includes("Server listening"), "server must not listen");
  assert.ok(!result.stdout.includes("Seeding demo"), "no demo seeding may start");
  return result;
}

test("production without any Clerk configuration refuses to start", async () => {
  await expectRefusal({ NODE_ENV: "production" }, ["CLERK_SECRET_KEY is not set", "CLERK_PUBLISHABLE_KEY is not set"]);
});

test("an unset NODE_ENV is treated as production (no silent demo mode)", async () => {
  await expectRefusal({}, ["CLERK_SECRET_KEY is not set"]);
});

test("production with malformed Clerk keys refuses to start", async () => {
  await expectRefusal(
    { NODE_ENV: "production", CLERK_SECRET_KEY: "not-a-secret", CLERK_PUBLISHABLE_KEY: "pk_wrong" },
    ["CLERK_SECRET_KEY is malformed", "CLERK_PUBLISHABLE_KEY is malformed"],
  );
});

test("production with DEMO_AUTH=true refuses to start, even with valid Clerk keys", async () => {
  await expectRefusal({ NODE_ENV: "production", ...FAKE_CLERK, DEMO_AUTH: "true" }, ["DEMO_AUTH=true"]);
});

test("production with SEED_DEMO_DATA=true refuses to start", async () => {
  await expectRefusal({ NODE_ENV: "production", ...FAKE_CLERK, SEED_DEMO_DATA: "true" }, ["SEED_DEMO_DATA=true"]);
});

test("refusal output never contains the secret key value", async () => {
  const secret = "sk_live_DONOTPRINTTHIS";
  const result = await expectRefusal({ NODE_ENV: "production", CLERK_SECRET_KEY: secret, CLERK_PUBLISHABLE_KEY: "bad" }, ["CLERK_PUBLISHABLE_KEY is malformed"]);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("DONOTPRINTTHIS"));
});

async function probeNetlify(env: Record<string, string>) {
  const result = await runEntry(NETLIFY_PROBE, childEnv({ DATABASE_URL: NO_DATABASE, ...env }));
  const line = result.stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  assert.ok(line, `probe produced no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line.slice("PROBE_RESULT ".length)) as Array<{ path: string; statusCode: number }>;
}

test("Netlify Function with DEMO_AUTH=true in production answers every request with 503", async () => {
  const results = await probeNetlify({ NODE_ENV: "production", ...FAKE_CLERK, DEMO_AUTH: "true", SEED_DEMO_DATA: "true" });
  assert.deepEqual(results.map((r) => r.statusCode), [503, 503, 503], JSON.stringify(results));
});

test("Netlify Function without Clerk in production answers every request with 503", async () => {
  const results = await probeNetlify({ NODE_ENV: "production" });
  assert.deepEqual(results.map((r) => r.statusCode), [503, 503, 503], JSON.stringify(results));
});

const prodDb = testDatabaseUrl("TEST_PROD_DATABASE_URL");

test("valid production configuration: demo tokens and forged roles are rejected, nothing demo is seeded", { skip: prodDb ? false : "TEST_PROD_DATABASE_URL not set" }, async () => {
  process.env.DATABASE_URL = prodDb!;
  const { pool } = await import("@workspace/db");
  const count = async (sql: string) => Number((await pool.query(sql)).rows[0].count);
  const DEMO_EMAILS = "('admin@masmila.co.za','manager@masmila.co.za','teamleader@masmila.co.za','reseller@masmila.co.za','newreseller@masmila.co.za','customer@masmila.co.za')";
  assert.equal(await count("select count(*) from resellers"), 0, "TEST_PROD_DATABASE_URL must start empty");

  // A refused start with demo seeding requested must leave the database untouched.
  await expectRefusal({ NODE_ENV: "production", ...FAKE_CLERK, SEED_DEMO_DATA: "true", DATABASE_URL: prodDb! }, ["SEED_DEMO_DATA=true"]);
  assert.equal(await count("select count(*) from users"), 0);

  // The database is marked as the production database (migrate --environment production).
  await pool.query(`insert into deployment_marker (id, environment, marked_by) values (1, 'production', 'test') on conflict (id) do nothing`);

  const port = await freePort();
  const { child } = await startEntry(SERVER, childEnv({ NODE_ENV: "production", ...FAKE_CLERK, DEPLOY_ENVIRONMENT: "production", DATABASE_URL: prodDb!, PORT: String(port) }), "Server listening");
  try {
    const base = `http://127.0.0.1:${port}/api`;
    const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

    assert.equal((await get("/healthz")).status, 200);
    assert.equal(((await (await get("/store-config")).json()) as { authMode: string }).authMode, "clerk");

    // Demo token for the seeded admin email (what an old demo build keeps in localStorage).
    const demoAdmin = { authorization: "Bearer demo:admin@masmila.co.za" };
    assert.equal((await get("/admin/summary", demoAdmin)).status, 401);
    assert.equal((await get("/reseller/dashboard", demoAdmin)).status, 401);
    const me = (await (await get("/me", demoAdmin)).json()) as { signedIn: boolean; isAdmin: boolean };
    assert.deepEqual([me.signedIn, me.isAdmin], [false, false]);

    // Client-side role claims carry no weight.
    const forged = { "x-user-role": "admin", "x-admin": "true", cookie: "role=admin; isAdmin=true", authorization: "Bearer not-a-real-session" };
    assert.equal((await get("/admin/summary?role=admin&isAdmin=true", forged)).status, 401);
    const patch = await fetch(`${base}/me`, { method: "PATCH", headers: { "content-type": "application/json", ...demoAdmin }, body: JSON.stringify({ role: "admin" }) });
    assert.equal(patch.status, 401);

    // Production start-up created no demo accounts, resellers, sample catalogue or sample marketing links.
    assert.equal(await count(`select count(*) from users where email in ${DEMO_EMAILS}`), 0);
    assert.equal(await count("select count(*) from resellers"), 0);
    assert.equal(await count("select count(*) from products"), 0);
    assert.equal(await count("select count(*) from marketing_materials"), 0);
    assert.equal(await count("select count(*) from compensation_settings"), 1, "base settings are still created");
  } finally {
    child.kill();
  }
});

test("a staging deployment connected to the production database refuses every API request", { skip: prodDb ? false : "TEST_PROD_DATABASE_URL not set" }, async () => {
  process.env.DATABASE_URL = prodDb!;
  const { pool } = await import("@workspace/db");
  // Runs after the test above, which marked this database "production".
  assert.equal((await pool.query("select environment from deployment_marker")).rows[0]?.environment, "production");
  const usersBefore = Number((await pool.query("select count(*) from users")).rows[0].count);
  const port = await freePort();
  const { child, output } = await startEntry(SERVER, childEnv({ NODE_ENV: "production", ...FAKE_CLERK, DEPLOY_ENVIRONMENT: "staging", DATABASE_URL: prodDb!, PORT: String(port) }), "Server listening");
  try {
    const base = `http://127.0.0.1:${port}/api`;
    for (const path of ["/healthz", "/store-config", "/products"]) assert.equal((await fetch(base + path)).status, 503, path);
    const post = await fetch(`${base}/newsletter`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "email", contact: "x@example.com" }) });
    assert.equal(post.status, 503);
    assert.equal(Number((await pool.query("select count(*) from users")).rows[0].count), usersBefore, "nothing written");
    assert.equal(Number((await pool.query("select count(*) from newsletter_subscribers")).rows[0].count), 0);
    assert.match(output(), /connected to the production database/);
  } finally {
    child.kill();
  }
});

after(async () => {
  if (!prodDb) return;
  const { pool } = await import("@workspace/db");
  await pool.end();
});
