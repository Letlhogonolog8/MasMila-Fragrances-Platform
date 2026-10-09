#!/usr/bin/env node
/**
 * Applies the version-controlled SQL migrations in lib/db/migrations, in name
 * order, each exactly once and each in its own transaction, recording them in
 * schema_migrations. Deliberately manual: no build, deploy or app start runs
 * this. See docs/DATABASE_MIGRATIONS.md.
 *
 *   pnpm --filter @workspace/db run migrate                     # dry run: show target and pending files
 *   pnpm --filter @workspace/db run migrate -- --apply          # apply pending files
 *   pnpm --filter @workspace/db run migrate -- --apply --baseline 0001_financial_integrity
 *       # record 0000…0001 as already applied (database created by drizzle-kit push / earlier psql runs)
 *   pnpm --filter @workspace/db run migrate -- --apply --environment production
 *       # also mark which environment this database belongs to (once; never changed by the runner)
 *
 * The target is DATABASE_URL only (never NETLIFY_DATABASE_URL or another
 * fallback), so the database being changed is always the one named explicitly.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * A table ("refunds") or column ("payment_events.shop_domain") each migration
 * creates. --baseline only records a migration whose marker exists (it really
 * is in the database), and a pending migration whose marker already exists is
 * refused (it was applied outside this runner).
 * Add an entry for every new migration.
 */
const MARKERS = {
  "0000_baseline": "orders",
  "0001_financial_integrity": "refunds",
  "0002_payment_integrity": "payment_events",
  "0003_operations": "job_runs",
  "0004_launch_safety": "deployment_marker",
  "0005_payment_provenance": "payment_events.shop_domain",
};

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const baselineAt = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : null;
const environment = args.includes("--environment") ? args[args.indexOf("--environment") + 1] : null;
if (environment !== null && !["production", "staging", "development"].includes(environment)) {
  console.error("migrate: --environment must be production, staging or development.");
  process.exit(1);
}

function fail(message) {
  console.error(`migrate: ${message}`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set. Set it explicitly to the database you intend to migrate.");
let target;
try {
  const parsed = new URL(url);
  target = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/${parsed.pathname.slice(1)}`;
} catch {
  fail("DATABASE_URL is not a valid connection URL.");
}

const files = readdirSync(dir)
  .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
  .sort()
  .map((f) => {
    const sql = readFileSync(join(dir, f), "utf8");
    // Checksum of the LF-normalised text: a Windows (CRLF) and a Linux checkout of the same file agree.
    return { name: f.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex") };
  });
if (baselineAt && !files.some((f) => f.name === baselineAt)) fail(`--baseline ${baselineAt}: no such migration.`);
for (const f of files) if (!MARKERS[f.name]) fail(`${f.name} has no entry in MARKERS (scripts/migrate.mjs).`);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // One runner at a time per database.
  await client.query("select pg_advisory_lock(hashtext('masmila:schema_migrations'))");
  const tracked = (await client.query("select to_regclass('public.schema_migrations') is not null as present")).rows[0].present;
  const applied = new Map(
    tracked ? (await client.query("select name, checksum from schema_migrations")).rows.map((r) => [r.name, r.checksum]) : [],
  );
  const hasOrders = (await client.query("select to_regclass('public.orders') is not null as present")).rows[0].present;

  for (const f of files) {
    if (applied.has(f.name) && applied.get(f.name) !== f.checksum) {
      fail(`${f.name} was changed after it was applied (checksum mismatch). Applied migrations are immutable; add a new migration instead.`);
    }
  }
  const baseline = baselineAt ? files.filter((f) => f.name <= baselineAt && !applied.has(f.name)) : [];
  const pending = files.filter((f) => !applied.has(f.name) && !baseline.includes(f));

  console.log(`migrate: target ${target}`);
  console.log(`migrate: applied ${applied.size ? [...applied.keys()].join(", ") : "(none)"}`);
  if (baseline.length) console.log(`migrate: to record as already applied (not run): ${baseline.map((f) => f.name).join(", ")}`);
  console.log(`migrate: pending ${pending.length ? pending.map((f) => f.name).join(", ") : "(none)"}`);
  // A marker is a table ("refunds") or a column ("payment_events.shop_domain").
  const exists = async (marker) => {
    const [table, column] = marker.split(".");
    if (!column) return (await client.query("select to_regclass($1) is not null as present", [`public.${table}`])).rows[0].present;
    return (await client.query("select count(*)::int > 0 as present from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2", [table, column])).rows[0].present;
  };
  for (const f of baseline) {
    if (!(await exists(MARKERS[f.name]))) fail(`--baseline: ${f.name} is not in this database (${MARKERS[f.name]} is missing). Choose an earlier baseline.`);
  }
  for (const f of pending) {
    if (await exists(MARKERS[f.name])) fail(`${f.name} looks already applied (${MARKERS[f.name]} exists) but is not recorded. Use --baseline ${f.name} if it was applied manually.`);
  }
  if (!tracked && hasOrders && !baselineAt) {
    fail("this database already has the Mas'Mila schema but no migration history (it was created with drizzle-kit push). " +
      "Re-run with --baseline <last migration already in it>; see docs/DATABASE_MIGRATIONS.md.");
  }
  const markerTable = (await client.query("select to_regclass('public.deployment_marker') is not null as present")).rows[0].present;
  const marker = markerTable ? (await client.query("select environment from deployment_marker where id = 1")).rows[0]?.environment ?? null : null;
  console.log(`migrate: environment marker ${marker ?? "(none)"}`);
  if (environment && marker && marker !== environment) {
    fail(`this database is marked "${marker}", not "${environment}". The runner never changes a marker; check you have the right DATABASE_URL.`);
  }
  if (!apply) {
    console.log("migrate: dry run — nothing changed. Re-run with --apply to apply.");
    process.exit(0);
  }

  await client.query(`create table if not exists "schema_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
)`);
  for (const f of baseline) {
    await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [f.name, f.checksum]);
    console.log(`migrate: recorded ${f.name} as already applied`);
  }
  for (const f of pending) {
    await client.query("begin");
    try {
      await client.query(f.sql);
      await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [f.name, f.checksum]);
      await client.query("commit");
      console.log(`migrate: applied ${f.name}`);
    } catch (err) {
      await client.query("rollback");
      fail(`${f.name} failed and was rolled back (nothing from it was applied; later migrations were not run): ${err.message}`);
    }
  }
  if (environment && !marker) {
    await client.query("insert into deployment_marker (id, environment, marked_by) values (1, $1, $2)", [environment, `migrate:${process.env.USER ?? process.env.USERNAME ?? "unknown"}`]);
    console.log(`migrate: marked this database as ${environment}`);
  }
  console.log("migrate: done");
} finally {
  await client.end();
}
