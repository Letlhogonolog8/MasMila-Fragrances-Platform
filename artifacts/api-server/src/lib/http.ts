import type { ErrorRequestHandler } from "express";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const forbidden = (message = "You do not have access to this area.") =>
  new HttpError(403, message);

type ZodLikeError = Error & {
  issues: Array<{ path: Array<string | number>; message: string }>;
};

function isZodError(err: unknown): err is ZodLikeError {
  return err instanceof Error && err.name === "ZodError" && "issues" in err;
}

/** Postgres codes for "gave up waiting": statement timeout, lock timeout, idle-in-transaction timeout. */
const TIMEOUT_CODES = new Set(["57014", "55P03", "25P03"]);
/** Postgres codes for a lost connection (server shutdown, connection failure). */
const CONNECTION_CODES = new Set(["53300", "57P01", "57P02", "57P03", "08000", "08001", "08003", "08006", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]);

/**
 * A database timeout or lost connection: the transaction was rolled back and
 * the request can be retried. Returns which, or null for any other error.
 */
export function databaseUnavailable(err: unknown): "timeout" | "connection" | null {
  for (let e = err as { code?: string; message?: string; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.code && TIMEOUT_CODES.has(e.code)) return "timeout";
    if (e.code && CONNECTION_CODES.has(e.code)) return "connection";
    if (typeof e.message === "string" && /timeout exceeded when trying to connect|Connection terminated|not queryable|terminating connection|not currently accepting connections/i.test(e.message)) return "connection";
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const unavailable = databaseUnavailable(err);
  if (unavailable) {
    req.log.warn({ event: "db.unavailable", kind: unavailable, code: (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code }, "Database timeout or connection loss; request rolled back");
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error: "We're busy right now and nothing was changed. Please try again in a moment." });
    return;
  }
  if (isZodError(err)) {
    const issue = err.issues[0];
    const field = issue?.path.join(".");
    res.status(400).json({
      error: field ? `${field}: ${issue.message}` : "Invalid request",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  req.log.error({ err }, "Unhandled request error");
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
};

export const round2 = (value: number) => Math.round(value * 100) / 100;

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
