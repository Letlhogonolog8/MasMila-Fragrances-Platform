# Mas'Mila Fragrances

Mas'Mila is a South African fragrance storefront with a reseller application flow and leadership dashboard foundation.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/masmila-fragrances` — React storefront, shop, reseller application, reseller portal, and admin dashboard.
- `artifacts/api-server/src/routes/masmila.ts` — typed demo API for product discovery, reseller applications, portal data, admin summaries, and compensation settings.
- `lib/api-spec/openapi.yaml` — source of truth for the Mas'Mila API contract.
- `lib/api-client-react/src/generated` — generated frontend hooks and schemas; regenerate with the API spec command after contract changes.

## Architecture decisions

- The initial build prioritizes the Phase 1 product surface from the proposal: public shopping, reseller onboarding, referral-ready portal views, and configurable incentive settings.
- Storefront and dashboard data flow through the shared OpenAPI-generated client, keeping the UI ready for a persistent Shopify/Postgres implementation.
- The proposal's 5% Team Leader, 2% Manager, and 1% Director rates are represented as editable settings rather than hard-coded UI copy.
- The current API uses seeded in-memory data so the product can be reviewed immediately; production Shopify, payments, courier, auth, and commission-ledger integrations remain follow-on work.

## Product

- Public home page, shop catalog, search/filtering, product cards, bag interaction, and brand story pages.
- Reseller application form with approval-queue response state.
- Reseller portal with rank, sales, bottle volume, team progress, referral code, recent activity, and incentive visibility.
- Admin dashboard with revenue, bottles, active resellers, weekly sales, top products, and editable compensation settings.

## User preferences

None recorded.

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after editing `lib/api-spec/openapi.yaml`.
- API routes live behind `/api`; the web artifact is served at `/`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
