import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Netlify DB (Neon) exposes NETLIFY_DATABASE_URL; everywhere else uses DATABASE_URL.
const connectionString = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const ms = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
};

/**
 * Limits that turn a stuck query, lock wait or abandoned transaction into an
 * error instead of a hang. Defaults are ~10× the slowest statements measured
 * in the integration suites (≤1 s, under 50 simultaneous checkouts contending
 * for one product row); see docs/OPERATIONS.md. Override per environment.
 */
export const dbTimeouts = {
  /** Longest a single statement inside a transaction may run. */
  statementMs: ms("DB_STATEMENT_TIMEOUT_MS", 15_000),
  /** Longest a statement waits for a row or advisory lock. */
  lockMs: ms("DB_LOCK_TIMEOUT_MS", 10_000),
  /** A transaction left open without a statement this long is ended by the server (its locks released). */
  idleInTransactionMs: ms("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", 15_000),
  /** Longest a request waits for a free pool connection before failing. */
  connectionMs: ms("DB_CONNECTION_TIMEOUT_MS", 10_000),
};

const onConnectionError = (err: Error) => console.error(`Database connection closed: ${err.message}`);

/**
 * Prepares every new connection before the pool hands it out:
 * - an error listener — a connection the server ends (idle-in-transaction
 *   timeout, restart) emits an error, which without a listener crashes the
 *   process even while the connection is checked out; pg then marks it
 *   unusable and the pool discards it (the query using it fails with a
 *   connection error, mapped to 503 by the API);
 * - session statement and lock timeouts for statements outside a transaction.
 *   Through a transaction-mode pooler a session setting may not reach every
 *   server connection, so set role defaults there too (docs/OPERATIONS.md).
 *   A failure to set them is logged, never fatal.
 */
async function prepareConnection(client: pg.PoolClient) {
  client.on("error", onConnectionError);
  try {
    await client.query(`SET statement_timeout = ${dbTimeouts.statementMs}; SET lock_timeout = ${dbTimeouts.lockMs}`);
  } catch (err) {
    console.error(`Could not set database session timeouts: ${(err as Error).message}`);
  }
}

export const pool = new Pool({ connectionString, connectionTimeoutMillis: dbTimeouts.connectionMs, onConnect: prepareConnection } as pg.PoolConfig);
// Errors on idle connections (between checkouts).
pool.on("error", onConnectionError);

const base = drizzle(pool, { schema });

/**
 * Every transaction starts by setting its timeouts with SET LOCAL. Unlike
 * startup parameters, these work through transaction-mode poolers
 * (PgBouncer, Neon's pooled endpoint), which reject startup `statement_timeout`.
 */
const transaction = base.transaction.bind(base);
base.transaction = ((callback, config) =>
  transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('statement_timeout', ${String(dbTimeouts.statementMs)}, true),
      set_config('lock_timeout', ${String(dbTimeouts.lockMs)}, true),
      set_config('idle_in_transaction_session_timeout', ${String(dbTimeouts.idleInTransactionMs)}, true)`);
    return callback(tx);
  }, config)) as typeof base.transaction;

export const db = base;

export * from "./schema";
