import { ensureBaseData, seedDemoNetwork } from "./seed";
import { autoCloseQualification } from "./network";
import { logger } from "./logger";

/**
 * Demo network: on by default outside production so the reseller, team and
 * incentive flows can be reviewed immediately; opt-in (SEED_DEMO_DATA=true)
 * in production.
 */
const seedDemo =
  process.env.SEED_DEMO_DATA === "true" ||
  (process.env.NODE_ENV !== "production" && process.env.SEED_DEMO_DATA !== "false");

/** Close last month's qualification automatically once the month has ended. */
export async function runScheduledJobs() {
  try {
    if (await autoCloseQualification()) logger.info("Closed last month's qualification automatically");
  } catch (err) {
    logger.error({ err }, "Automatic month-end qualification failed");
  }
}

/** Base data (settings, catalogue, content), the optional demo network and due scheduled jobs. */
export async function prepareData() {
  await ensureBaseData();
  if (seedDemo) await seedDemoNetwork();
  await runScheduledJobs();
}
