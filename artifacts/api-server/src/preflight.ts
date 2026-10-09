import { pool } from "@workspace/db";
import { runPreflight } from "./lib/preflight";

/**
 * `pnpm --filter @workspace/api-server run preflight` with the target
 * deployment's environment variables (staging first, then production).
 * Read-only. Prints each check (never a secret value); exit code 1 if any fail.
 */
process.env.LOG_LEVEL ??= "silent";
const checks = await runPreflight();
const mark = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
for (const c of checks) console.log(`${mark[c.status]}  ${c.name.padEnd(28)} ${c.detail}`);
const failed = checks.filter((c) => c.status === "fail").length;
const warned = checks.filter((c) => c.status === "warn").length;
console.log(`\n${failed} failed, ${warned} warning(s), ${checks.length - failed - warned} passed.${failed ? " Not ready." : ""}`);
await pool.end();
process.exit(failed ? 1 : 0);
