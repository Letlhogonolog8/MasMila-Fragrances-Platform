import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { db, productsTable, usersTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { configuredShopDomain, deploymentEnvironment, isProduction, productionConfigErrors, productionConfigWarnings } from "./runtime-env";
import { databaseEnvironmentErrors } from "./environment-guard";
import { isShopifyConfigured, shopifyStorefrontRequest } from "./shopifyStorefrontClient";
import { trustedProxyHops } from "./client-ip";

/**
 * Launch preflight: checks a deployment's configuration and database before
 * (and after) going live — without printing any secret value. Run with the
 * target environment's variables: `pnpm --filter @workspace/api-server run
 * preflight`. Read-only: it changes nothing.
 */

export type Check = { name: string; status: "pass" | "warn" | "fail"; detail: string };

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "..", "lib", "db", "migrations");

/** Accounts created only by the demo seed (never by a real sign-up). */
export const DEMO_ACCOUNTS = [
  "customer@masmila.co.za",
  "manager@masmila.co.za",
  "teamleader@masmila.co.za",
  "reseller@masmila.co.za",
  "newreseller@masmila.co.za",
  "sipho@masmila.co.za",
  "lerato@masmila.co.za",
  "zodwa.applicant@example.com",
];

const present = (env: NodeJS.ProcessEnv, name: string) => Boolean(env[name]?.trim());

function configurationChecks(env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = [];
  if (!isProduction(env)) {
    checks.push({ name: "runtime", status: "fail", detail: `NODE_ENV=${env.NODE_ENV} is a development/test mode. Run preflight with the deployment's production settings.` });
  }
  const deployment = deploymentEnvironment(env);
  checks.push(
    deployment
      ? { name: "deployment environment", status: "pass", detail: deployment }
      : { name: "deployment environment", status: "fail", detail: "Unknown: set DEPLOY_ENVIRONMENT=production|staging (Netlify sets it from the deploy context at build time)." },
  );
  for (const error of productionConfigErrors(env)) checks.push({ name: "authentication", status: "fail", detail: error });
  for (const warning of productionConfigWarnings(env)) checks.push({ name: "configuration", status: "warn", detail: warning });
  const required: Array<[string, boolean, string]> = [
    ["DATABASE_URL", present(env, "DATABASE_URL") || present(env, "NETLIFY_DATABASE_URL"), "database connection"],
    ["SITE_URL", present(env, "SITE_URL"), "links in emails, referral links, sitemap"],
    ["ADMIN_EMAILS", present(env, "ADMIN_EMAILS"), "who can be an administrator"],
    ["CLERK_SECRET_KEY", present(env, "CLERK_SECRET_KEY"), "sign-in (API)"],
    ["CLERK_PUBLISHABLE_KEY", present(env, "CLERK_PUBLISHABLE_KEY"), "sign-in (API)"],
  ];
  for (const [name, ok, purpose] of required) checks.push({ name, status: ok ? "pass" : "fail", detail: ok ? `set (${purpose})` : `missing — needed for ${purpose}` });
  checks.push(
    present(env, "VITE_CLERK_PUBLISHABLE_KEY")
      ? { name: "VITE_CLERK_PUBLISHABLE_KEY", status: env.VITE_CLERK_PUBLISHABLE_KEY === env.CLERK_PUBLISHABLE_KEY ? "pass" : "fail", detail: env.VITE_CLERK_PUBLISHABLE_KEY === env.CLERK_PUBLISHABLE_KEY ? "set, same as CLERK_PUBLISHABLE_KEY" : "differs from CLERK_PUBLISHABLE_KEY" }
      : { name: "VITE_CLERK_PUBLISHABLE_KEY", status: "warn", detail: "not visible here; it must be set for the storefront build (same value as CLERK_PUBLISHABLE_KEY)" },
  );
  for (const name of ["DEMO_AUTH", "SEED_DEMO_DATA"]) {
    if (present(env, name)) checks.push({ name, status: "fail", detail: "must not be set in a deployment" });
  }
  // Credentials must belong to this environment: staging never signs in with
  // the production Clerk instance, production never with a development one.
  const secret = env.CLERK_SECRET_KEY?.trim() ?? "";
  if (deployment && secret) {
    const live = secret.startsWith("sk_live_");
    const ok = deployment === "production" ? live : !live;
    checks.push({
      name: "Clerk instance",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${live ? "production (sk_live_)" : "development (sk_test_)"} instance, as expected for ${deployment}`
        : deployment === "production"
          ? "production uses a Clerk development instance (sk_test_): use the production instance"
          : "staging uses a production Clerk instance (sk_live_): use a separate development instance",
    });
  }
  const shopify = present(env, "SHOPIFY_STORE_DOMAIN") || present(env, "SHOPIFY_STOREFRONT_TOKEN") || present(env, "REPLIT_CONNECTORS_HOSTNAME");
  if (shopify) {
    const storefront = (present(env, "SHOPIFY_STORE_DOMAIN") && present(env, "SHOPIFY_STOREFRONT_TOKEN")) || present(env, "REPLIT_CONNECTORS_HOSTNAME");
    checks.push({ name: "Shopify storefront", status: storefront ? "pass" : "fail", detail: storefront ? "configured" : "SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_TOKEN must both be set" });
    checks.push({ name: "SHOPIFY_WEBHOOK_SECRET", status: present(env, "SHOPIFY_WEBHOOK_SECRET") ? "pass" : "fail", detail: present(env, "SHOPIFY_WEBHOOK_SECRET") ? "set" : "missing — every Shopify payment webhook would be rejected" });
    const shop = configuredShopDomain(env);
    if (shop) {
      const valid = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
      checks.push({
        name: "SHOPIFY_STORE_DOMAIN",
        status: valid ? "pass" : "fail",
        detail: valid
          ? `${shop}: webhooks are accepted only from this store (X-Shopify-Shop-Domain)`
          : "must be the store's <name>.myshopify.com domain (not a custom domain): webhooks are matched against it",
      });
    }
    if (deployment) {
      checks.push({
        name: "Shopify payment policy",
        status: "pass",
        detail: deployment === "staging"
          ? "staging: only Shopify test payments settle orders; a live payment is quarantined (live_payment_in_staging)"
          : "production: only live payments settle orders; test payments are quarantined",
      });
    }
  } else {
    checks.push({ name: "Shopify", status: "warn", detail: "not configured: checkout offers EFT only" });
  }
  checks.push(
    present(env, "RESEND_API_KEY") && present(env, "NOTIFY_FROM_EMAIL")
      ? { name: "email", status: "pass", detail: "RESEND_API_KEY and NOTIFY_FROM_EMAIL set" }
      : { name: "email", status: "warn", detail: "RESEND_API_KEY / NOTIFY_FROM_EMAIL not set: customers and administrators get no emails (in-app notifications only)" },
  );
  if (!env.NETLIFY_DEPLOY_CONTEXT) {
    let hops: number | null = null;
    try {
      hops = trustedProxyHops(env);
    } catch (err) {
      checks.push({ name: "TRUSTED_PROXY_HOPS", status: "fail", detail: (err as Error).message });
    }
    if (hops === 0) checks.push({ name: "TRUSTED_PROXY_HOPS", status: "warn", detail: "0 (long-running server): behind a proxy every visitor shares one rate-limit allowance. Verify with /api/admin/diagnostics/client-ip and set it." });
    else if (hops != null) checks.push({ name: "TRUSTED_PROXY_HOPS", status: "pass", detail: `${hops} — confirm it was verified on this host` });
  }
  return checks;
}

async function databaseChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    await db.execute(sql`select 1`);
    checks.push({ name: "database", status: "pass", detail: "reachable" });
  } catch (err) {
    return [{ name: "database", status: "fail", detail: `unreachable (${(err as Error).message.split("\n")[0]})` }];
  }

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const recorded = new Map<string, string>();
  try {
    const rows = await db.execute<{ name: string; checksum: string }>(sql`select name, checksum from schema_migrations`);
    for (const r of rows.rows) recorded.set(r.name, r.checksum);
  } catch {
    /* no history table: reported below */
  }
  const missing = files.filter((f) => !recorded.has(f.replace(/\.sql$/, "")));
  const changed = files.filter((f) => {
    const name = f.replace(/\.sql$/, "");
    return recorded.has(name) && recorded.get(name) !== createHash("sha256").update(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  });
  checks.push(
    missing.length || changed.length
      ? { name: "migrations", status: "fail", detail: [missing.length && `not applied: ${missing.join(", ")}`, changed.length && `changed after applying: ${changed.join(", ")}`].filter(Boolean).join("; ") }
      : { name: "migrations", status: "pass", detail: `all ${files.length} applied, checksums match` },
  );

  try {
    const errors = await databaseEnvironmentErrors(env);
    checks.push(errors.length ? { name: "environment marker", status: "fail", detail: errors.join(" ") } : { name: "environment marker", status: "pass", detail: `database marked ${deploymentEnvironment(env)}` });
  } catch (err) {
    checks.push({ name: "environment marker", status: "fail", detail: (err as Error).message });
  }

  const demo = await db.select({ email: usersTable.email }).from(usersTable).where(inArray(usersTable.email, DEMO_ACCOUNTS));
  checks.push(
    demo.length
      ? { name: "demo data", status: "fail", detail: `${demo.length} demo account(s) present — this database was seeded with demo data` }
      : { name: "demo data", status: "pass", detail: "no demo accounts" },
  );
  return checks;
}

type VariantPrices = { nodes: Array<{ id: string; availableForSale: boolean; price: { amount: string; currencyCode: string } } | null> };

/**
 * Shopify must charge exactly the storefront price, or every Shopify payment
 * is quarantined (lib/payments.ts). Compares each active product's Shopify
 * variant price (ZA buyer context) with its retail price. Delivery charges and
 * Shopify discount codes cannot be checked this way.
 */
export async function shopifyPriceChecks(): Promise<Check[]> {
  if (!isShopifyConfigured()) return [];
  const products = await db
    .select({ name: productsTable.name, size: productsTable.size, retailPrice: productsTable.retailPrice, variant: productsTable.shopifyVariantId })
    .from(productsTable)
    .where(eq(productsTable.status, "active"));
  const linked = products.filter((p) => p.variant);
  const unlinked = products.length - linked.length;
  const checks: Check[] = [];
  if (unlinked) checks.push({ name: "Shopify variants", status: "warn", detail: `${unlinked} active product(s) have no Shopify variant: carts containing them fall back to EFT` });
  if (!linked.length) return checks;
  const gid = (v: string) => (v.startsWith("gid://") ? v : `gid://shopify/ProductVariant/${v}`);
  let data: VariantPrices;
  try {
    data = await shopifyStorefrontRequest<VariantPrices>(
      `#graphql
        query VariantPrices($ids: [ID!]!) @inContext(country: ZA) {
          nodes(ids: $ids) { ... on ProductVariant { id availableForSale price { amount currencyCode } } }
        }`,
      { ids: linked.map((p) => gid(p.variant!)) },
    );
  } catch (err) {
    return [...checks, { name: "Shopify prices", status: "fail", detail: `could not read variant prices: ${(err as Error).message.slice(0, 200)}` }];
  }
  const mismatches: string[] = [];
  linked.forEach((p, i) => {
    const node = data.nodes[i];
    const label = `${p.name} ${p.size}`;
    if (!node) mismatches.push(`${label}: variant not found in Shopify`);
    else if (node.price.currencyCode !== "ZAR") mismatches.push(`${label}: Shopify price is in ${node.price.currencyCode}`);
    else if (Math.round(Number(node.price.amount) * 100) !== Math.round(p.retailPrice * 100)) mismatches.push(`${label}: Shopify R${Number(node.price.amount).toFixed(2)} vs storefront R${p.retailPrice.toFixed(2)}`);
  });
  checks.push(
    mismatches.length
      ? { name: "Shopify prices", status: "fail", detail: `${mismatches.length} of ${linked.length} differ — their Shopify payments would be quarantined: ${mismatches.slice(0, 10).join("; ")}` }
      : { name: "Shopify prices", status: "pass", detail: `all ${linked.length} variant prices equal the storefront's (delivery charges and discount codes not checked)` },
  );
  return checks;
}

export async function runPreflight(env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const checks = configurationChecks(env);
  const database = await databaseChecks(env);
  checks.push(...database);
  if (database.some((c) => c.name === "database" && c.status === "pass")) checks.push(...(await shopifyPriceChecks()));
  return checks;
}
