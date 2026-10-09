import app, { configErrors } from "./app";
import { logger } from "./lib/logger";
import { prepareData } from "./lib/prepare";
import { runDueJobs } from "./lib/jobs";
import { clientIpSource, trustedProxyHops } from "./lib/client-ip";
import { isProduction } from "./lib/runtime-env";

// Unsafe production auth configuration: refuse to start (details logged by app.ts).
if (configErrors.length) {
  console.error(`Refusing to start: unsafe production configuration.\n- ${configErrors.join("\n- ")}`);
  process.exit(1);
}

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
    // Long-running server: due jobs at start and hourly. Best effort only (an
    // autoscaled instance may be asleep): the dependable trigger is the `jobs`
    // command on a schedule — see docs/OPERATIONS.md. Overlap is harmless.
    void runDueJobs("startup");
    setInterval(() => void runDueJobs("schedule"), 60 * 60 * 1000).unref();
    if (isProduction() && clientIpSource() === "socket" && trustedProxyHops() === 0) {
      logger.warn(
        { event: "config.proxy_untrusted" },
        "TRUSTED_PROXY_HOPS is not set: client addresses are the direct TCP peer. Behind a proxy every visitor then shares one rate-limit bucket. Verify the hop count (GET /api/admin/diagnostics/client-ip) and set it.",
      );
    }
  });
