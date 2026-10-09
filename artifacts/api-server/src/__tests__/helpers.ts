import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

export const API_DIR = path.resolve(import.meta.dirname, "..", "..");

/**
 * A throwaway test database URL from the named variable, or null when unset.
 * Refuses anything that is not on this machine: these suites seed demo data
 * and create users, so they must never point at a shared or live database.
 */
export function testDatabaseUrl(variable: string): string | null {
  const raw = process.env[variable];
  if (!raw) return null;
  const host = new URL(raw).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && process.env.ALLOW_NONLOCAL_TEST_DB !== "true") {
    throw new Error(`${variable} must point at a local throwaway database (got host "${host}").`);
  }
  return raw;
}

const AUTH_VARS = ["NODE_ENV", "DEMO_AUTH", "DISABLE_DEMO_AUTH", "SEED_DEMO_DATA", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "ADMIN_EMAILS", "DATABASE_URL", "NETLIFY_DATABASE_URL", "PORT"];

/** The parent environment with every auth/data variable removed, plus `overrides`. */
export function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of AUTH_VARS) delete env[key];
  return { ...env, LOG_LEVEL: "info", ...overrides };
}

/** Format-valid fake Clerk keys — not real credentials. */
export const FAKE_CLERK = {
  CLERK_SECRET_KEY: "sk_live_FAKEFAKEFAKEFAKE",
  CLERK_PUBLISHABLE_KEY: `pk_live_${Buffer.from("clerk.masmila.invalid$").toString("base64").replace(/=+$/, "")}`,
};

/** Unreachable database: proves a failure happened before any database access. */
export const NO_DATABASE = "postgres://nobody:nobody@127.0.0.1:1/none";

export type RunResult = { code: number | null; stdout: string; stderr: string };

/** Runs a TypeScript entry point (relative to the API package) with tsx until it exits. */
export function runEntry(entry: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: API_DIR, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${entry} did not exit within ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Starts a long-running entry point and resolves once `readyText` appears on stdout. */
export function startEntry(entry: string, env: NodeJS.ProcessEnv, readyText: string, timeoutMs = 90_000): Promise<{ child: ChildProcess; output: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], { cwd: API_DIR, env });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${entry} not ready within ${timeoutMs}ms.\n${output}`));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      output += d;
      if (output.includes(readyText)) {
        clearTimeout(timer);
        resolve({ child, output: () => output });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (d) => (output += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${entry} exited early with code ${code}.\n${output}`));
    });
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}
