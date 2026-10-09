import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import webhookRouter from "./routes/webhooks";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { clerkEnabled, loadSession } from "./lib/auth";
import { errorHandler } from "./lib/http";
import { productionConfigErrors, productionConfigWarnings } from "./lib/runtime-env";
import { trustedProxyHops } from "./lib/client-ip";
import { environmentGate } from "./lib/environment-guard";
import { sharedRateLimit } from "./lib/rate-limit";

const app: Express = express();
// Never `true`: that would let any visitor choose their own IP (and rate-limit
// bucket) with an X-Forwarded-For header. See lib/client-ip.ts.
app.set("trust proxy", trustedProxyHops());
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Fail closed: with an unsafe production auth configuration (missing/malformed
// Clerk keys, DEMO_AUTH or SEED_DEMO_DATA requested) no API request is served.
export const configErrors = productionConfigErrors();
if (configErrors.length) {
  for (const error of configErrors) logger.fatal(`Unsafe production configuration: ${error}`);
  app.use("/api", (_req, res) => {
    res.status(503).json({ error: "The service is temporarily unavailable." });
  });
}
for (const warning of productionConfigWarnings()) logger.warn(warning);
// Maintenance switch (incidents, restores): MAINTENANCE_MODE=true answers every API
// request — webhooks included, so Shopify retries them later — with 503, without
// touching the database. Read per request, so it takes effect without a restart
// on a long-running server. The health check still answers.
app.use("/api", (req, res, next) => {
  if (process.env.MAINTENANCE_MODE !== "true" || req.path === "/healthz") return next();
  res.setHeader("Retry-After", "300");
  res.status(503).json({ error: "Mas'Mila is briefly offline for maintenance. Please try again shortly." });
});
// Never serve from a database that belongs to another environment (lib/environment-guard.ts).
app.use("/api", environmentGate);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// The storefront and API share an origin, so cross-origin access is opt-in
// (credentials + reflected origins would let any site act as a signed-in user).
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({ credentials: true, origin: allowedOrigins.length ? allowedOrigins : false }));

// Raw-body webhook routes must run before the JSON parser.
app.use("/api", webhookRouter);

// Admin file uploads arrive base64-encoded (4 MB file ≈ 5.4 MB of JSON).
app.use("/api/admin/files", express.json({ limit: "6mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

if (clerkEnabled) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
} else {
  logger.warn("CLERK_SECRET_KEY is not set — Clerk authentication is disabled");
}

app.use(
  ["/api/checkout", "/api/reseller-applications", "/api/enquiries", "/api/newsletter", "/api/orders/track"],
  // Shared across instances (lib/rate-limit.ts); runs after the environment gate.
  sharedRateLimit(20, 10 * 60 * 1000),
);

app.use("/api", loadSession, router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use(errorHandler);

export default app;
