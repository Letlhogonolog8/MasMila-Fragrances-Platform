import { configErrors } from "./app";
import { logger } from "./lib/logger";
import { runDueJobs } from "./lib/jobs";
import { checkDatabaseEnvironment } from "./lib/environment-guard";
import { pool } from "@workspace/db";

/**
 * Command-line trigger for scheduled work (`pnpm --filter @workspace/api-server
 * run jobs` after a build): for a Replit Scheduled Deployment or any external
 * cron, hourly. Safe to run as often and as concurrently as you like.
 * Exit code 1 if a job failed (the failure is also recorded and alerted).
 */
if (configErrors.length) {
  console.error(`Refusing to run jobs: unsafe production configuration.\n- ${configErrors.join("\n- ")}`);
  process.exit(1);
}
const environmentErrors = await checkDatabaseEnvironment();
if (environmentErrors.length) {
  console.error(`Refusing to run jobs:\n- ${environmentErrors.join("\n- ")}`);
  await pool.end();
  process.exit(1);
}
const result = await runDueJobs("cli");
logger.info({ event: "jobs.cli_finished", result }, "Scheduled jobs finished");
await pool.end();
const failed = result.monthEnd.some((m) => m.status === "failed") || (result.expiry != null && ("error" in result.expiry || result.expiry.failed > 0));
process.exit(failed ? 1 : 0);
