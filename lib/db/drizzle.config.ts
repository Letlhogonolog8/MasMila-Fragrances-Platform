import { defineConfig } from "drizzle-kit";

// Netlify DB (Neon) exposes NETLIFY_DATABASE_URL; everywhere else uses DATABASE_URL.
const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;

if (!url) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Relative (forward-slash) path: drizzle-kit globs fail on Windows absolute paths.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
});
