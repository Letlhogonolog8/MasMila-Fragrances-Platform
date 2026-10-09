/**
 * Checks that need no database: client-IP derivation rules, database-error
 * mapping, and deployment safety (no automatic schema push in the Netlify
 * build or the Replit hooks; drizzle-kit refuses there). Rate limiting over
 * HTTP needs the shared counters in the database: launch.integration.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { API_DIR, NO_DATABASE } from "./helpers";

const REPO = path.resolve(API_DIR, "..", "..");
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL ??= NO_DATABASE;

test("TRUSTED_PROXY_HOPS: default 0 (never trust X-Forwarded-For); only small whole numbers accepted", async () => {
  const ip = await import("../lib/client-ip");
  assert.equal(ip.trustedProxyHops({}), 0);
  assert.equal(ip.trustedProxyHops({ TRUSTED_PROXY_HOPS: "1" }), 1);
  for (const bad of ["true", "-1", "1.5", "99", "all"]) assert.throws(() => ip.trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), /TRUSTED_PROXY_HOPS/);
});

test("Netlify: only a valid x-nf-client-connection-ip identifies the client; X-Forwarded-For never does", async () => {
  const ip = await import("../lib/client-ip");
  const req = (headers: Record<string, string>) => ({ headers, ip: "127.0.0.1", socket: {} }) as unknown as Parameters<typeof ip.clientIp>[0];
  ip.useClientIpSource("netlify");
  try {
    assert.equal(ip.clientIp(req({ "x-nf-client-connection-ip": "192.0.2.50", "x-forwarded-for": "203.0.113.9" })), "192.0.2.50");
    assert.equal(ip.clientIp(req({ "x-nf-client-connection-ip": "2001:db8::1" })), "2001:db8::1");
    assert.equal(ip.clientIp(req({ "x-nf-client-connection-ip": "not-an-ip" })), "unknown");
    assert.equal(ip.clientIp(req({ "x-forwarded-for": "203.0.113.9" })), "unknown");
  } finally {
    ip.useClientIpSource("socket");
  }
  assert.equal(ip.clientIp(req({ "x-forwarded-for": "203.0.113.9" })), "127.0.0.1", "outside Netlify: the TCP peer (Express decides with trust proxy)");
});

test("database timeouts and lost connections are recognised (→ 503, retryable)", async () => {
  const { databaseUnavailable } = await import("../lib/http");
  const wrapped = (code: string) => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("db"), { code }) });
  assert.equal(databaseUnavailable(wrapped("57014")), "timeout", "statement timeout");
  assert.equal(databaseUnavailable(wrapped("55P03")), "timeout", "lock timeout");
  assert.equal(databaseUnavailable(wrapped("25P03")), "timeout", "idle-in-transaction timeout");
  assert.equal(databaseUnavailable(new Error("timeout exceeded when trying to connect")), "connection", "pool exhausted");
  assert.equal(databaseUnavailable(new Error("Connection terminated unexpectedly")), "connection");
  assert.equal(databaseUnavailable(wrapped("ECONNREFUSED")), "connection", "database down");
  assert.equal(databaseUnavailable(wrapped("23505")), null, "a unique violation is not a timeout");
  assert.equal(databaseUnavailable(new Error("boom")), null);
});

test("no automatic schema push: Netlify build, Replit post-merge hook and Replit config", () => {
  const netlify = readFileSync(path.join(REPO, "netlify.toml"), "utf8");
  const command = netlify.match(/^\s*command\s*=\s*"([^"]*)"/m)?.[1] ?? "";
  assert.ok(command.includes("build"), "build command found");
  assert.doesNotMatch(command, /push|drizzle|migrate/, "the build never changes the database");
  const postMerge = readFileSync(path.join(REPO, "scripts", "post-merge.sh"), "utf8");
  assert.doesNotMatch(postMerge.replace(/^#.*$/gm, ""), /push|drizzle|migrate/, "the post-merge hook never changes the database");
  const replit = readFileSync(path.join(REPO, ".replit"), "utf8");
  assert.doesNotMatch(replit, /push|drizzle-kit|migrate/, ".replit runs no schema change");
});

test("drizzle-kit refuses to run in a Netlify build or a Replit deployment", () => {
  const dbDir = path.join(REPO, "lib", "db");
  for (const env of [{ NETLIFY: "true" }, { REPLIT_DEPLOYMENT: "1" }]) {
    // Pointed at an unreachable database: even if the guard failed, nothing could change.
    const run = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
      cwd: dbDir,
      env: { ...process.env, ...env, DATABASE_URL: NO_DATABASE },
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
    });
    assert.notEqual(run.status, 0, `${JSON.stringify(env)}: must fail`);
    assert.match(`${run.stdout}${run.stderr}`, /drizzle-kit is disabled in Netlify builds and Replit deployments/, JSON.stringify(env));
  }
});
