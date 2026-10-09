import { pool } from "@workspace/db";
import { stagingEvidence } from "./lib/staging-evidence";

/**
 * `pnpm --filter @workspace/api-server run staging-evidence [-- --order MM-…] [--limit 30]`
 * with the STAGING database's DATABASE_URL. Read-only; prints Markdown for the
 * test record (docs/STAGING.md). No customer contact details or secrets.
 */
process.env.LOG_LEVEL ??= "silent";
const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] ?? null : null);
console.log(await stagingEvidence({ order: value("--order"), limit: Number(value("--limit") ?? 20) }));
await pool.end();
