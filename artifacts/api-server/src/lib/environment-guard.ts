import type { RequestHandler } from "express";
import { db, deploymentMarkerTable } from "@workspace/db";
import { deploymentEnvironment, isProduction } from "./runtime-env";
import { logger } from "./logger";

/**
 * Refuses to serve from a database that belongs to another environment: a
 * deploy preview (staging) connected to the production database, or the
 * production site connected to a staging copy. The database says what it is
 * (deployment_marker, set with `migrate --environment`); the deployment says
 * what it is (runtime-env.ts → deploymentEnvironment). Production mode only.
 */
export async function databaseEnvironmentErrors(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (!isProduction(env)) return [];
  const expected = deploymentEnvironment(env);
  if (!expected) return []; // reported by productionConfigErrors
  let marker: { environment: string } | undefined;
  try {
    [marker] = await db.select({ environment: deploymentMarkerTable.environment }).from(deploymentMarkerTable);
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (code === "42P01") return ["The database is not migrated (no deployment_marker table). Apply lib/db/migrations with the migration runner."];
    throw err; // unreachable database: not a verdict, try again later
  }
  if (!marker) return [`The database has no environment marker. Mark it with the migration runner (--environment ${expected}) after confirming DATABASE_URL is the ${expected} database.`];
  if (marker.environment !== expected) {
    return [`This ${expected} deployment is connected to the ${marker.environment} database. Refusing to serve: give this deploy context its own DATABASE_URL.`];
  }
  return [];
}

let verdict: Promise<string[]> | null = null;

/** The memoised check (re-run after an unreachable database). */
export async function checkDatabaseEnvironment(): Promise<string[]> {
  verdict ??= databaseEnvironmentErrors().then((errors) => {
    for (const error of errors) logger.fatal({ event: "config.database_environment" }, `Unsafe database: ${error}`);
    return errors;
  });
  try {
    return await verdict;
  } catch (err) {
    verdict = null;
    throw err;
  }
}

/** Express gate: 503 for every API request while the database is the wrong one (or unverifiable). */
export const environmentGate: RequestHandler = async (_req, res, next) => {
  if (!isProduction()) return next();
  try {
    if ((await checkDatabaseEnvironment()).length) {
      res.status(503).json({ error: "The service is temporarily unavailable." });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
};
