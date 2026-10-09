import { ensureBaseData, seedDemoNetwork } from "./seed";
import { demoSeedAllowed, isProduction } from "./runtime-env";
import { checkDatabaseEnvironment } from "./environment-guard";

/**
 * Demo network: on by default in development/test so the reseller, team and
 * incentive flows can be reviewed immediately (SEED_DEMO_DATA=false turns it
 * off). Never in production — see runtime-env.ts.
 */
const seedDemo = demoSeedAllowed();

/**
 * Base data (settings, catalogue, content) and the optional demo network.
 * Scheduled work (month-end, reservation expiry) is not run here: it has its
 * own triggers — see lib/jobs.ts and docs/OPERATIONS.md.
 */
export async function prepareData() {
  // Nothing is written to a database that belongs to another environment.
  if (isProduction() && (await checkDatabaseEnvironment()).length) return;
  await ensureBaseData();
  if (seedDemo) await seedDemoNetwork();
}
