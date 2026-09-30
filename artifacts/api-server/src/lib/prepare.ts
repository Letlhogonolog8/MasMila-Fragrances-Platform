import { ensureBaseData, seedDemoNetwork } from "./seed";

/**
 * Demo network: on by default outside production so the reseller, team and
 * incentive flows can be reviewed immediately; opt-in (SEED_DEMO_DATA=true)
 * in production.
 */
const seedDemo =
  process.env.SEED_DEMO_DATA === "true" ||
  (process.env.NODE_ENV !== "production" && process.env.SEED_DEMO_DATA !== "false");

/** Base data (settings, catalogue, content) plus the optional demo network. */
export async function prepareData() {
  await ensureBaseData();
  if (seedDemo) await seedDemoNetwork();
}
