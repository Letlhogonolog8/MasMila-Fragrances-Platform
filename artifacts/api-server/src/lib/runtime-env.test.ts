import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deploymentEnvironment,
  demoAuthAllowed,
  demoSeedAllowed,
  productionConfigErrors,
  productionConfigWarnings,
  runtimeEnvironment,
  verifiedPrimaryEmail,
} from "./runtime-env";

// Format-valid fakes (not real credentials).
const CLERK = { CLERK_SECRET_KEY: "sk_live_FAKEFAKEFAKE", CLERK_PUBLISHABLE_KEY: "pk_live_ZmFrZS5leGFtcGxlLmNvbSQ" };
/** A complete production deployment (fake values). */
const PROD = { NODE_ENV: "production", ...CLERK, DEPLOY_ENVIRONMENT: "production", ADMIN_EMAILS: "owner@example.com", SITE_URL: "https://shop.example" };

test("only an explicit development/test NODE_ENV is non-production; unset or unknown is production", () => {
  assert.equal(runtimeEnvironment({ NODE_ENV: "development" }), "development");
  assert.equal(runtimeEnvironment({ NODE_ENV: "test" }), "test");
  assert.equal(runtimeEnvironment({}), "production");
  assert.equal(runtimeEnvironment({ NODE_ENV: "staging" }), "production");
  assert.equal(runtimeEnvironment({ NODE_ENV: "Development" }), "production");
});

test("demo auth is never available in production, even when DEMO_AUTH=true is requested", () => {
  assert.equal(demoAuthAllowed({ NODE_ENV: "production", DEMO_AUTH: "true" }), false);
  assert.equal(demoAuthAllowed({ DEMO_AUTH: "true" }), false); // unset NODE_ENV
  assert.equal(demoAuthAllowed({ NODE_ENV: "production" }), false);
});

test("demo auth works only in explicit development/test without Clerk", () => {
  assert.equal(demoAuthAllowed({ NODE_ENV: "development" }), true);
  assert.equal(demoAuthAllowed({ NODE_ENV: "test" }), true);
  assert.equal(demoAuthAllowed({ NODE_ENV: "development", ...CLERK }), false);
  assert.equal(demoAuthAllowed({ NODE_ENV: "development", DISABLE_DEMO_AUTH: "true" }), false);
});

test("demo seeding is never available in production, even when SEED_DEMO_DATA=true is requested", () => {
  assert.equal(demoSeedAllowed({ NODE_ENV: "production", SEED_DEMO_DATA: "true" }), false);
  assert.equal(demoSeedAllowed({ SEED_DEMO_DATA: "true" }), false);
  assert.equal(demoSeedAllowed({ NODE_ENV: "development" }), true);
  assert.equal(demoSeedAllowed({ NODE_ENV: "development", SEED_DEMO_DATA: "false" }), false);
});

test("valid production configuration has no errors", () => {
  assert.deepEqual(productionConfigErrors(PROD), []);
  assert.deepEqual(productionConfigErrors({ ...PROD, SEED_DEMO_DATA: "false" }), []);
});

test("a production-mode deployment must say whether it is production or staging", () => {
  const { DEPLOY_ENVIRONMENT: _omit, ...unknown } = PROD;
  assert.ok(productionConfigErrors(unknown).some((e) => e.includes("DEPLOY_ENVIRONMENT")));
  assert.ok(productionConfigErrors({ ...PROD, DEPLOY_ENVIRONMENT: "prod" }).some((e) => e.includes("DEPLOY_ENVIRONMENT")));
  assert.equal(deploymentEnvironment({ DEPLOY_ENVIRONMENT: "staging" }), "staging");
  // Netlify: from the deploy context baked in at build time — previews and branch deploys are staging.
  assert.equal(deploymentEnvironment({ NETLIFY_DEPLOY_CONTEXT: "production" }), "production");
  assert.equal(deploymentEnvironment({ NETLIFY_DEPLOY_CONTEXT: "deploy-preview", DEPLOY_ENVIRONMENT: "production" }), "staging");
  assert.equal(deploymentEnvironment({ NETLIFY_DEPLOY_CONTEXT: "branch-deploy" }), "staging");
  assert.equal(deploymentEnvironment({}), null);
});

test("production without Clerk is an error, not a silent fallback", () => {
  const errors = productionConfigErrors({ NODE_ENV: "production" });
  assert.ok(errors.some((e) => e.includes("CLERK_SECRET_KEY is not set")));
  assert.ok(errors.some((e) => e.includes("CLERK_PUBLISHABLE_KEY is not set")));
  assert.ok(productionConfigErrors({}).length >= 2, "unset NODE_ENV is held to production rules");
});

test("malformed Clerk keys are errors", () => {
  const errors = productionConfigErrors({ NODE_ENV: "production", CLERK_SECRET_KEY: "pk_live_swapped", CLERK_PUBLISHABLE_KEY: "not-a-key" });
  assert.ok(errors.some((e) => e.includes("CLERK_SECRET_KEY is malformed")));
  assert.ok(errors.some((e) => e.includes("CLERK_PUBLISHABLE_KEY is malformed")));
});

test("requesting demo auth or demo data in production is an error", () => {
  const errors = productionConfigErrors({ NODE_ENV: "production", ...CLERK, DEMO_AUTH: "true", SEED_DEMO_DATA: "true" });
  assert.ok(errors.some((e) => e.startsWith("DEMO_AUTH=true")));
  assert.ok(errors.some((e) => e.startsWith("SEED_DEMO_DATA=true")));
});

test("error messages never echo secret values", () => {
  const secret = "sk_live_SUPERSECRETVALUE";
  const errors = productionConfigErrors({ NODE_ENV: "production", CLERK_SECRET_KEY: `${secret} `.repeat(2) });
  assert.ok(errors.every((e) => !e.includes("SUPERSECRETVALUE")));
});

test("development/test configurations are never blocked", () => {
  assert.deepEqual(productionConfigErrors({ NODE_ENV: "development", DEMO_AUTH: "true", SEED_DEMO_DATA: "true" }), []);
  assert.deepEqual(productionConfigErrors({ NODE_ENV: "test" }), []);
});

test("Shopify payment policy: production settles live payments only, staging test payments only", async () => {
  const { shopifyPaymentPolicy, configuredShopDomain } = await import("./runtime-env");
  const STAGING = { ...PROD, DEPLOY_ENVIRONMENT: "staging" };
  assert.deepEqual(shopifyPaymentPolicy(PROD), { allowTest: false, requireTest: false }, "production: no test payments");
  assert.deepEqual(shopifyPaymentPolicy({ ...PROD, SHOPIFY_ALLOW_TEST_ORDERS: "true" }), { allowTest: false, requireTest: false }, "the flag cannot enable test payments in production");
  assert.deepEqual(shopifyPaymentPolicy(STAGING), { allowTest: true, requireTest: true }, "staging: test payments only — never real money");
  assert.deepEqual(shopifyPaymentPolicy({ ...STAGING, NETLIFY_DEPLOY_CONTEXT: "production" }), { allowTest: false, requireTest: false }, "Netlify production context wins");
  assert.deepEqual(shopifyPaymentPolicy({ ...PROD, NETLIFY_DEPLOY_CONTEXT: "deploy-preview" }), { allowTest: true, requireTest: true }, "a Netlify deploy preview is staging");
  assert.deepEqual(shopifyPaymentPolicy({ NODE_ENV: "production" }), { allowTest: false, requireTest: false }, "unknown deployment");
  assert.deepEqual(shopifyPaymentPolicy({ NODE_ENV: "test" }), { allowTest: false, requireTest: false });
  assert.deepEqual(shopifyPaymentPolicy({ NODE_ENV: "test", SHOPIFY_ALLOW_TEST_ORDERS: "true" }), { allowTest: true, requireTest: false });
  assert.equal(configuredShopDomain({ SHOPIFY_STORE_DOMAIN: " https://MasMila-Staging.myshopify.com/ " }), "masmila-staging.myshopify.com");
  assert.equal(configuredShopDomain({}), null);
});

test("credential and configuration warnings: Clerk instance per environment, administrators, site URL", () => {
  assert.deepEqual(productionConfigWarnings(PROD), []);
  const warns = (env: Record<string, string>) => productionConfigWarnings(env).join(" | ");
  assert.match(warns({ ...PROD, CLERK_SECRET_KEY: "sk_test_abc" }), /development-instance key/);
  assert.match(warns({ ...PROD, DEPLOY_ENVIRONMENT: "staging" }), /staging deployment uses a live Clerk key/);
  assert.doesNotMatch(warns({ ...PROD, DEPLOY_ENVIRONMENT: "staging", CLERK_SECRET_KEY: "sk_test_abc" }), /Clerk/);
  assert.match(warns({ ...PROD, ADMIN_EMAILS: " , " }), /ADMIN_EMAILS is empty/);
  assert.match(warns({ ...PROD, SITE_URL: "" }), /SITE_URL is not set/);
});

test("only a verified Clerk primary email can identify an account", () => {
  const user = (emailAddress: string | null, status: string | null) => ({ primaryEmailAddress: { emailAddress, verification: { status } } });
  assert.equal(verifiedPrimaryEmail(user("Admin@MasMila.co.za ", "verified")), "admin@masmila.co.za");
  assert.equal(verifiedPrimaryEmail(user("admin@masmila.co.za", "unverified")), null);
  assert.equal(verifiedPrimaryEmail(user("admin@masmila.co.za", null)), null);
  assert.equal(verifiedPrimaryEmail({ primaryEmailAddress: { emailAddress: "admin@masmila.co.za" } }), null);
  assert.equal(verifiedPrimaryEmail({ primaryEmailAddress: null }), null);
  assert.equal(verifiedPrimaryEmail(user(null, "verified")), null);
});
