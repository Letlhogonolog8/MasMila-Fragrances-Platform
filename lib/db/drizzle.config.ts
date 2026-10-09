import { defineConfig } from "drizzle-kit";

// drizzle-kit (push) is for development databases only. Netlify builds and Replit
// deployments can see a deployed DATABASE_URL, so refuse outright there: deployed
// databases change only through the reviewed migrations in ./migrations
// (docs/DATABASE_MIGRATIONS.md).
if (process.env.NETLIFY === "true" || process.env.REPLIT_DEPLOYMENT) {
  throw new Error(
    "drizzle-kit is disabled in Netlify builds and Replit deployments. Apply lib/db/migrations with `pnpm --filter @workspace/db run migrate` (see docs/DATABASE_MIGRATIONS.md).",
  );
}

// Netlify DB (Neon) exposes NETLIFY_DATABASE_URL; everywhere else uses DATABASE_URL.
const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;

if (!url) {
  throw new Error(
    "No database configured. Set DATABASE_URL, or on Netlify add the Netlify DB (Neon) extension, which provides NETLIFY_DATABASE_URL.",
  );
}

export default defineConfig({
  // Relative (forward-slash) path: drizzle-kit globs fail on Windows absolute paths.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
});
