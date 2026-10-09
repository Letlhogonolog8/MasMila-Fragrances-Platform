import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { db, rateLimitsTable } from "@workspace/db";
import { lt, sql } from "drizzle-orm";
import { clientIp } from "./client-ip";

/**
 * Fixed-window rate limit shared by every server instance and serverless
 * function: one atomic upsert per request on a counter row in the database
 * (keyed by a hash of client address + endpoint, never the raw address). With
 * the database unavailable the request fails with 503 like any other
 * database-backed request — the limit is never skipped.
 */
export function sharedRateLimit(limit: number, windowMs: number): RequestHandler {
  const windowSecs = windowMs / 1000;
  return async (req, res, next) => {
    try {
      const bucket = createHash("sha256").update(`${clientIp(req)}|${req.baseUrl}`).digest("hex").slice(0, 40);
      const result = await db.execute<{ count: number }>(sql`
        insert into rate_limits (bucket, window_start, count) values (${bucket}, now(), 1)
        on conflict (bucket) do update set
          count = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSecs}) then 1 else rate_limits.count + 1 end,
          window_start = case when rate_limits.window_start <= now() - make_interval(secs => ${windowSecs}) then now() else rate_limits.window_start end
        returning count`);
      if (Number(result.rows[0]!.count) > limit) {
        res.setHeader("Retry-After", String(Math.ceil(windowSecs)));
        res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Removes counters whose window ended long ago (run with the scheduled jobs). */
export async function pruneRateLimits(olderThanMs = 24 * 3600_000) {
  const removed = await db
    .delete(rateLimitsTable)
    .where(lt(rateLimitsTable.windowStart, new Date(Date.now() - olderThanMs)))
    .returning({ bucket: rateLimitsTable.bucket });
  return removed.length;
}
