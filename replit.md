# Mas'Mila Fragrances

South African fragrance storefront + reseller portal + team/commission engine + admin console, built from the Mas'Mila proposal. See `docs/IMPLEMENTATION.md` for section-by-section coverage of the proposal.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the API (needs `PORT`, `DATABASE_URL`)
- `pnpm --filter @workspace/masmila-fragrances run dev` — storefront (needs `PORT`, `BASE_PATH`; set `API_PROXY_TARGET=http://localhost:<api port>` when not behind the Replit router)
- `pnpm --filter @workspace/api-server test` — commission/qualification engine tests
- `pnpm run typecheck` / `pnpm run build`
- `pnpm --filter @workspace/api-spec run codegen` — regenerate hooks + Zod after editing `lib/api-spec/openapi.yaml`
- `pnpm --filter @workspace/db run push` — push schema (use `push-force` if drizzle-kit asks about renamed columns)

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | API | Postgres |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` | API / web | Authentication. Without them, a **demo sign-in** (seeded accounts) is available outside production only. |
| `ADMIN_EMAILS` | API | Comma-separated emails that are always administrators |
| `SITE_URL` | API | Public URL for referral links, sitemap, emails (default `https://masmila.co.za`) |
| `SEED_DEMO_DATA` | API | `true` seeds the demo network in production; `false` disables it in development |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | API | Email delivery for notifications (in-app notifications always work) |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_STOREFRONT_TOKEN` (or the Replit Shopify connector), `SHOPIFY_WEBHOOK_SECRET` | API | Shopify hosted checkout + order/refund webhooks at `/api/webhooks/shopify` |
| `CORS_ORIGINS` | API | Only if the API must be called from another origin |
| `VITE_GA_MEASUREMENT_ID`, `VITE_META_PIXEL_ID`, `VITE_TIKTOK_PIXEL_ID`, `VITE_GOOGLE_SITE_VERIFICATION` | web | Analytics (loaded after cookie consent) |

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
