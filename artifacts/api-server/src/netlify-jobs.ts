import "./netlify-context";
import { configErrors } from "./app";
import { logger } from "./lib/logger";
import { runDueJobs } from "./lib/jobs";
import { checkDatabaseEnvironment } from "./lib/environment-guard";

/**
 * Netlify Scheduled Function (schedule in netlify.toml, hourly): month-end
 * qualification and unpaid EFT reservation expiry. Netlify limits scheduled
 * functions to 30 seconds; a run cut short loses its lease and the next hour
 * resumes it (see docs/OPERATIONS.md).
 */
export const handler = async () => {
  if (configErrors.length) {
    logger.fatal({ event: "jobs.refused", configErrors }, "Unsafe production configuration; scheduled jobs not run");
    return { statusCode: 503 };
  }
  if ((await checkDatabaseEnvironment()).length) return { statusCode: 503 };
  const result = await runDueJobs("schedule");
  logger.info({ event: "jobs.scheduled_finished", result }, "Scheduled jobs finished");
  return { statusCode: 200 };
};
