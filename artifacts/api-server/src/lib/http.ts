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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
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
