/**
 * Which kind of environment the API is running in, and whether its
 * authentication configuration is safe for it. Pure functions of an env
 * object so the rules can be unit-tested.
 *
 * Only an explicit NODE_ENV of "development" or "test" counts as
 * non-production. Anything else — including an unset NODE_ENV — is treated
 * as production, so a forgotten variable can never enable demo sign-in or
 * demo data.
 */
type Env = Record<string, string | undefined>;

export type RuntimeEnvironment = "development" | "test" | "production";

export function runtimeEnvironment(env: Env = process.env): RuntimeEnvironment {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test" ? env.NODE_ENV : "production";
}

export const isProduction = (env: Env = process.env) => runtimeEnvironment(env) === "production";

export const clerkConfigured = (env: Env = process.env) => Boolean(env.CLERK_SECRET_KEY);

/** Passwordless "sign in as any email" — development and test only, and never alongside Clerk. */
export function demoAuthAllowed(env: Env = process.env) {
  return !isProduction(env) && !clerkConfigured(env) && env.DISABLE_DEMO_AUTH !== "true";
}

/** Demo reseller network, sample catalogue and sample marketing links — development and test only. */
export function demoSeedAllowed(env: Env = process.env) {
  return !isProduction(env) && env.SEED_DEMO_DATA !== "false";
}

export type DeploymentEnvironment = "production" | "staging";

/**
 * Which deployment this production-mode process is: on Netlify, from the
 * deploy context baked in at build time (`production` → production; deploy
 * previews and branch deploys → staging); elsewhere from DEPLOY_ENVIRONMENT.
 * Null when unknown. Compared with the database's environment marker, so a
 * preview can never serve from (or write to) the production database.
 */
export function deploymentEnvironment(env: Env = process.env): DeploymentEnvironment | null {
  const netlifyContext = env.NETLIFY_DEPLOY_CONTEXT?.trim();
  if (netlifyContext) return netlifyContext === "production" ? "production" : "staging";
  const declared = env.DEPLOY_ENVIRONMENT?.trim();
  return declared === "production" || declared === "staging" ? declared : null;
}

const SECRET_KEY_RE = /^sk_(live|test)_[A-Za-z0-9]+$/;
const PUBLISHABLE_KEY_RE = /^pk_(live|test)_[A-Za-z0-9+/=_-]+$/;

/**
 * Configuration problems that make production unsafe to serve. A non-empty
 * result means the API must not start (long-running server) or must answer
 * every request with 503 (serverless). Messages never include secret values.
 */
export function productionConfigErrors(env: Env = process.env): string[] {
  if (!isProduction(env)) return [];
  const errors: string[] = [];
  if (env.DEMO_AUTH === "true") {
    errors.push("DEMO_AUTH=true is set. Demo sign-in is never allowed in production; remove the variable.");
  }
  if (env.SEED_DEMO_DATA === "true") {
    errors.push("SEED_DEMO_DATA=true is set. Demo accounts and sample data are never seeded in production; remove the variable.");
  }
  const secret = env.CLERK_SECRET_KEY?.trim();
  if (!secret) errors.push("CLERK_SECRET_KEY is not set. Production requires Clerk authentication.");
  else if (!SECRET_KEY_RE.test(secret)) errors.push("CLERK_SECRET_KEY is malformed (expected sk_live_… or sk_test_…).");
  const publishable = env.CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishable) errors.push("CLERK_PUBLISHABLE_KEY is not set. Production requires Clerk authentication.");
  else if (!PUBLISHABLE_KEY_RE.test(publishable)) errors.push("CLERK_PUBLISHABLE_KEY is malformed (expected pk_live_… or pk_test_…).");
  if (!deploymentEnvironment(env)) {
    errors.push("DEPLOY_ENVIRONMENT must be \"production\" or \"staging\" (Netlify builds set this from the deploy context). It is checked against the database's environment marker.");
  }
  return errors;
}

/**
 * Accounts (and admin rights via ADMIN_EMAILS) attach to a Clerk user by
 * email address, so only a primary email that Clerk has verified may be used.
 */
export function verifiedPrimaryEmail(clerkUser: {
  primaryEmailAddress?: { emailAddress?: string | null; verification?: { status?: string | null } | null } | null;
}): string | null {
  const primary = clerkUser.primaryEmailAddress;
  const email = primary?.emailAddress?.trim().toLowerCase();
  return email && primary?.verification?.status === "verified" ? email : null;
}

/**
 * Which Shopify payments may settle orders here:
 * - production deployment: live payments only (a test payment is rejected);
 * - staging deployment: test payments only (Bogus Gateway / provider test
 *   mode). A live, real-money payment is rejected, so staging never acts on
 *   real money even if it is wired to the live store by mistake;
 * - development and test: live payments, plus test payments when
 *   SHOPIFY_ALLOW_TEST_ORDERS=true.
 */
export function shopifyPaymentPolicy(env: Env = process.env): { allowTest: boolean; requireTest: boolean } {
  if (!isProduction(env)) return { allowTest: env.SHOPIFY_ALLOW_TEST_ORDERS === "true", requireTest: false };
  return deploymentEnvironment(env) === "staging" ? { allowTest: true, requireTest: true } : { allowTest: false, requireTest: false };
}

/** Whether Shopify test payments may settle orders (see shopifyPaymentPolicy). */
export const shopifyTestPaymentsAllowed = (env: Env = process.env) => shopifyPaymentPolicy(env).allowTest;

/** The configured Shopify store's domain, normalised (e.g. "masmila-staging.myshopify.com"), or null. */
export function configuredShopDomain(env: Env = process.env): string | null {
  const raw = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase();
  return raw ? raw.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;
}

/** Non-fatal production warnings (e.g. a Clerk development instance). */
export function productionConfigWarnings(env: Env = process.env): string[] {
  if (!isProduction(env)) return [];
  const warnings: string[] = [];
  const deployment = deploymentEnvironment(env);
  if (deployment === "production" && env.CLERK_SECRET_KEY?.startsWith("sk_test_")) {
    warnings.push("CLERK_SECRET_KEY is a Clerk development-instance key (sk_test_). Use a production instance (sk_live_) for the live site.");
  }
  if (deployment === "staging" && env.CLERK_SECRET_KEY?.startsWith("sk_live_")) {
    warnings.push("This staging deployment uses a live Clerk key (sk_live_). Use a separate Clerk instance for staging so staging cannot sign in production users.");
  }
  if (!(env.ADMIN_EMAILS ?? "").split(",").some((e) => e.trim())) {
    warnings.push("ADMIN_EMAILS is empty: nobody can become an administrator, and administrator alerts (failed month-end runs, quarantined payments) reach no one.");
  }
  if (!env.SITE_URL) {
    warnings.push("SITE_URL is not set: emails, referral links and the sitemap use https://masmila.co.za.");
  }
  const shopifyCheckout = Boolean((env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_STOREFRONT_TOKEN) || env.REPLIT_CONNECTORS_HOSTNAME);
  if (shopifyCheckout && !env.SHOPIFY_WEBHOOK_SECRET) {
    warnings.push("Shopify checkout is configured but SHOPIFY_WEBHOOK_SECRET is not: every Shopify webhook will be rejected and Shopify orders will never be marked paid.");
  }
  if (env.SHOPIFY_ALLOW_TEST_ORDERS) {
    warnings.push(`SHOPIFY_ALLOW_TEST_ORDERS has no effect in a deployment: ${deployment === "staging" ? "staging accepts only test payments" : "the production deployment rejects test payments"}.`);
  }
  return warnings;
}
