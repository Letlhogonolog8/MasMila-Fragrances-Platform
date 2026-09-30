import express, { type Express, type RequestHandler } from "express";
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

const app: Express = express();
app.set("trust proxy", true);
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

/** Minimal fixed-window rate limiter for public write endpoints. */
function rateLimit(limit: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.baseUrl}`;
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
      return next();
    }
    if (++entry.count > limit) {
      res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
      return;
    }
    next();
  };
}
app.use(
  ["/api/checkout", "/api/reseller-applications", "/api/enquiries", "/api/newsletter", "/api/orders/track"],
  rateLimit(20, 10 * 60 * 1000),
);

app.use("/api", loadSession, router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});
app.use(errorHandler);

export default app;
