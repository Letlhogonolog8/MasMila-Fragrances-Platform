import { isIP } from "node:net";
import type { Request } from "express";

/**
 * Where the client's IP address comes from — only sources the deployment
 * itself controls, never a header a visitor can simply send:
 *
 * - `netlify` (set by the Netlify Function entry, src/netlify.ts): Netlify's
 *   proxy puts the connecting client's address in `x-nf-client-connection-ip`,
 *   the only client-IP header Netlify supports. X-Forwarded-For is ignored.
 * - otherwise (long-running server: Replit, devcontainer, local): the TCP
 *   peer, unless TRUSTED_PROXY_HOPS = n says exactly n proxies sit in front of
 *   the app. Express then takes the address n hops from the right of
 *   X-Forwarded-For — entries further left were written by the client and are
 *   ignored. Default 0: X-Forwarded-For is never trusted.
 */
export type ClientIpSource = "netlify" | "socket";

let source: ClientIpSource = "socket";

export function useClientIpSource(next: ClientIpSource) {
  source = next;
}

export function clientIpSource() {
  return source;
}

/** Value for Express's "trust proxy" setting: a hop count, never `true`. */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error(`TRUSTED_PROXY_HOPS must be a whole number from 0 to 5 (got "${raw}").`);
  }
  return hops;
}

/** The client address used for rate limiting and visitor hashing. */
export function clientIp(req: Request): string {
  if (source === "netlify") {
    const header = req.headers["x-nf-client-connection-ip"];
    const value = (Array.isArray(header) ? header[0] : header)?.trim();
    return value && isIP(value) ? value : "unknown";
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
