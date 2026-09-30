import serverless from "serverless-http";
import app from "./app";
import { logger } from "./lib/logger";
import { prepareData } from "./lib/prepare";

/**
 * Netlify Function entry: the same Express app, served on /api/* via the
 * redirect in netlify.toml. Base data is prepared once per cold start.
 */
const ready = prepareData().catch((err) => logger.error({ err }, "Failed to prepare base data"));

type FnRequest = { url?: string; body?: unknown; _body?: boolean; headers: Record<string, string | string[] | undefined> };

/**
 * serverless-http hands Express a request that is already "complete", with
 * the raw bytes in req.body — Express 5's body parsers then skip it. Parse
 * JSON / form bodies here instead. Webhooks keep the raw Buffer because
 * their HMAC signature is computed over the exact bytes.
 */
function parseBody(req: FnRequest) {
  if (!Buffer.isBuffer(req.body)) return;
  req._body = true; // tell express.json / express.raw the body is handled
  if (req.url?.startsWith("/api/webhooks/")) return;
  const raw = req.body.toString("utf8");
  const type = String(req.headers["content-type"] ?? "");
  if (!raw) req.body = {};
  else if (type.includes("application/json")) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = {};
    }
  } else if (type.includes("application/x-www-form-urlencoded")) {
    req.body = Object.fromEntries(new URLSearchParams(raw));
  }
}

const serve = serverless(app, {
  request(req: FnRequest) {
    // Rewritten requests can arrive as /.netlify/functions/api/...; the app routes on /api/...
    if (req.url) req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, "/api");
    parseBody(req);
  },
});

export const handler = async (event: object, context: object) => {
  await ready;
  return serve(event, context);
};
