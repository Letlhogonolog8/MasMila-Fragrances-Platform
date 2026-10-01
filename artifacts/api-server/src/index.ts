import app from "./app";
import { logger } from "./lib/logger";
import { prepareData, runScheduledJobs } from "./lib/prepare";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

prepareData()
  .catch((err) => logger.error({ err }, "Failed to prepare base data"))
  .finally(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");
    });
    // Long-running server: check for a month to close every hour.
    setInterval(() => void runScheduledJobs(), 60 * 60 * 1000).unref();
  });
