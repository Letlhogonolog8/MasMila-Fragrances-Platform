# Mas'Mila Fragrances

South African fragrance storefront + reseller portal + team/commission engine + admin console, built from the Mas'Mila proposal. See `docs/IMPLEMENTATION.md` for section-by-section coverage of the proposal.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the API (needs `PORT`, `DATABASE_URL`)
- `pnpm --filter @workspace/masmila-fragrances run dev` — storefront (needs `PORT`, `BASE_PATH`; set `API_PROXY_TARGET=http://localhost:<api port>` when not behind the Replit router)
- `pnpm --filter @workspace/api-server test` — engine, auth-configuration and payment-verification unit tests (no database)
- `pnpm --filter @workspace/api-server run test:integration` — production start-up safety, HTTP authorization, financial-integrity (refunds, reversals, payouts) and payment/checkout (Shopify webhooks, concurrent checkouts) suites. Needs **local throwaway** databases with the schema applied (the suites refuse non-local hosts): `TEST_DATABASE_URL` (the demo network is seeded into it), `TEST_PROD_DATABASE_URL` (must start empty), `TEST_FINANCE_DATABASE_URL` and `TEST_PAYMENTS_DATABASE_URL` (fresh for each run; these suites create triggers and data). Create each with `createdb` + `DATABASE_URL=… pnpm --filter @workspace/db run migrate -- --apply`. Without them the database-backed tests are skipped.
- Refunds, incentive reversals and the payout lifecycle: `docs/FINANCIAL_INTEGRITY.md`. Payments, Shopify webhooks, checkout retries, logs and alerts: `docs/PAYMENTS.md`.
- Deployed databases change only through `lib/db/migrations` + `pnpm --filter @workspace/db run migrate` (dry run unless `-- --apply`): `docs/DATABASE_MIGRATIONS.md`. Neither the Netlify build nor the Replit post-merge hook touches the database.
- `pnpm --filter @workspace/api-server run jobs` (after `build`) — runs due scheduled work once: month-end qualification and unpaid EFT expiry. Schedule it hourly (Replit Scheduled Deployment or cron); Netlify uses the `scheduled-jobs` function. See `docs/OPERATIONS.md` (also: client IP / rate limits, database timeouts, payment review, decisions needed).
- `TEST_OPS_DATABASE_URL`, `TEST_LAUNCH_DATABASE_URL` and `TEST_ACCEPTANCE_DATABASE_URL` (each fresh per run, migrated, no environment marker) enable the operations, launch-safety and client acceptance suites.
- `pnpm --filter @workspace/api-server run preflight` — read-only launch check of a deployment's settings and database (no secrets printed); see `docs/LAUNCH_READINESS.md`.
- `pnpm --filter @workspace/api-server run staging-evidence -- [--order MM-…]` — read-only evidence report for the staging execution record (`docs/STAGING.md`).
- `pnpm run typecheck` / `pnpm run build`
- `pnpm --filter @workspace/api-spec run codegen` — regenerate hooks + Zod after editing `lib/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run push` — push schema to a **local/development** database (use `push-force` if drizzle-kit asks about renamed columns). Refused inside Netlify builds; never use it on staging or production.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | API | Postgres |
| `NODE_ENV` | API | Only `development` or `test` count as non-production. **Unset or anything else = production rules.** |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` | API / web | Authentication. **Required in production** (see below). |
| `ADMIN_EMAILS` | API | Comma-separated emails that are administrators once signed in with that **Clerk-verified** email |
| `SITE_URL` | API | Public URL for referral links, sitemap, emails (default `https://masmila.co.za`) |
| `SEED_DEMO_DATA` | API | Development/test only: `false` skips the demo network and sample catalogue. Setting it to `true` in production blocks the API (503). |
| `DEMO_AUTH` | API | Not used outside production; setting it to `true` in production blocks the API (503). |
| `DISABLE_DEMO_AUTH` | API | Development/test only: `true` turns the demo sign-in off |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | API | Email delivery for notifications (in-app notifications always work) |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_STOREFRONT_TOKEN` (or the Replit Shopify connector), `SHOPIFY_WEBHOOK_SECRET` | API | Shopify hosted checkout + order/refund webhooks at `/api/webhooks/shopify` (see `docs/PAYMENTS.md`). Without the secret every webhook is refused. |
| `SHOPIFY_ALLOW_TEST_ORDERS` | API | Development/test only: `true` lets Shopify test orders settle orders. No effect in a deployment: staging settles **only** test payments, production **never**. |
| `MAINTENANCE_MODE` | API | `true` = every API request (webhooks included) answers 503 "offline for maintenance" without touching the database; for incidents and restores (`docs/LAUNCH_READINESS.md`). Health check still answers. |
| `DEPLOY_ENVIRONMENT` | API (Replit / long-running server) | `production` or `staging`. Required in production mode; must match the database's environment marker. Netlify derives it from the deploy context. |
| `TRUSTED_PROXY_HOPS` | API (long-running server) | Number of proxies in front of the server whose `X-Forwarded-For` entry is trusted for client addresses (rate limits). Default 0 = none. Verify with `/api/admin/diagnostics/client-ip` before setting (`docs/OPERATIONS.md`). Not used on Netlify. |
| `DB_STATEMENT_TIMEOUT_MS`, `DB_LOCK_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_CONNECTION_TIMEOUT_MS` | API | Database limits (defaults 15 s / 10 s / 15 s / 10 s) |
| `MONTH_END_LEASE_MS`, `MONTH_END_MAX_ATTEMPTS`, `MONTH_END_RETRY_BASE_MS`, `MONTH_END_RETRY_CAP_MS` | API | Month-end run lease and automatic retry policy (defaults 10 min, 5, 15 min, 6 h) |
| `CORS_ORIGINS` | API | Only if the API must be called from another origin |
| `VITE_GA_MEASUREMENT_ID`, `VITE_META_PIXEL_ID`, `VITE_TIKTOK_PIXEL_ID`, `VITE_GOOGLE_SITE_VERIFICATION` | web | Analytics (loaded after cookie consent) |

## Production authentication

Production = any `NODE_ENV` other than `development`/`test` (the Netlify function and the Replit deployment always build as production).

Required:
- `CLERK_SECRET_KEY` = `sk_live_…`, `CLERK_PUBLISHABLE_KEY` = `pk_live_…` (API runtime), `VITE_CLERK_PUBLISHABLE_KEY` = the same `pk_live_…` (storefront build). A `sk_test_…` development-instance key is accepted with a warning.
- In the Clerk dashboard: require email verification for sign-up, and enforce MFA for administrator accounts.

Must not be set: `DEMO_AUTH`, `SEED_DEMO_DATA`.

Safe failure behaviour:
- Missing or malformed Clerk keys, or `DEMO_AUTH`/`SEED_DEMO_DATA` set → the long-running server **refuses to start** (exit 1, reasons logged without secret values); the Netlify function answers **every `/api` request with 503** and never touches the database.
- Storefront built without `VITE_CLERK_PUBLISHABLE_KEY` → sign-in pages show "Sign-in is temporarily unavailable". The demo sign-in exists only in the Vite dev server and is not in production bundles; any demo identity left in a browser is cleared and never sent.
- Identity always comes from the server: Clerk session → account by Clerk user id, or by **verified** primary email for a first sign-in. An account already linked to a different Clerk user is never re-linked. Roles come only from the database (`users.role`, `resellers`); headers, cookies, query strings and request bodies cannot grant them.
- Production start-up creates only the settings row (and `ADMIN_EMAILS` accounts). No demo accounts, demo network, sample catalogue or sample marketing links — those exist only in development/test.

The demo sign-in and demo network (accounts listed in `docs/IMPLEMENTATION.md`) are for local development: `NODE_ENV=development`, no Clerk keys.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9; Express 5 API; React 19 + Vite + wouter + TanStack Query storefront
- PostgreSQL + Drizzle ORM; OpenAPI → Orval (React Query hooks + Zod validators)
- Clerk authentication; Shopify Storefront API for hosted checkout

## Where things live

- `lib/db/src/schema/masmila.ts` — data model: users, resellers (sponsor/upline), products (cost + reseller price private), orders/items, qualification periods, commission ledger, payouts, settings, audit logs, notifications, fraud flags, marketing, enquiries, wishlist, site content
- `artifacts/api-server/src/lib/engine.ts` — pure qualification/rank/incentive rules (tested in `engine.test.ts`)
- `artifacts/api-server/src/lib/network.ts` — volumes, live network evaluation, ledger accrual/reversal, month-end run
- `artifacts/api-server/src/lib/orders.ts` — checkout, payment, fulfilment, refunds/cancellations
- `artifacts/api-server/src/routes/` — `catalog`, `checkout`, `account`, `reseller`, `admin`, `webhooks`, `seo`
- `artifacts/masmila-fragrances/src/pages/` — storefront, content pages, account, reseller portal, admin console

## Architecture decisions

- Postgres is the source of truth for products, pricing and the reseller/commission system (a proper data model, not spreadsheets or metafields); Shopify is used for hosted checkout when configured, with EFT checkout otherwise.
- Every compensation/qualification rule lives in `compensation_settings` and is editable in Admin → Settings; nothing is hard-coded.
- Incentives accrue provisionally when an order is paid, are confirmed or voided by the month-end qualification run, and flow Pending → Approved → Paid. Refunds reverse unpaid accruals or create clawback rows; nothing is deleted.
- Incentives are only calculated on product sales (never recruitment). A unique index prevents duplicate claims.

## Gotchas

- Run codegen after editing `openapi.yaml`.
- API routes live behind `/api`; the web artifact is served at `/`.
- Month-end qualification is run from Admin → Incentives & payouts (idempotent; safe to re-run).
- Windows development: the workspace strips non-Linux native binaries (esbuild/rollup/tailwind), so build the web app on Linux/Replit.

## User preferences

None recorded.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
