# Database migrations

Deployed databases (staging, production) change **only** through the reviewed
SQL files in `lib/db/migrations`, applied by hand with the migration runner.
Nothing else changes their schema:

- The Netlify build does not touch the database.
- The Replit post-merge hook (`scripts/post-merge.sh`) only installs
  dependencies.
- `drizzle-kit` refuses to run when `NETLIFY=true` (Netlify builds) or
  `REPLIT_DEPLOYMENT` is set (Replit deployments), via
  `lib/db/drizzle.config.ts`. So even a command edited back to `push` fails
  instead of changing a schema. A test (`edge-safety.test.ts`) checks the
  build command, the hook, `.replit` and both refusals.
- The app never migrates on start-up.
- `pnpm --filter @workspace/db run push` / `push-force` are for local and
  development databases only, run by hand (the devcontainer runs it once on
  creation, against its own database).

## Files

| File | What it does |
|---|---|
| `0000_baseline.sql` | The original schema (commit `f7a6946`), exported with `drizzle-kit export`. Only for an empty database. |
| `0001_financial_integrity.sql` | Phase 2: refunds, refund lines, ledger refund links, payout lifecycle. Additive. See `FINANCIAL_INTEGRITY.md`. |
| `0002_payment_integrity.sql` | Phase 3: order-number sequence, checkout idempotency key, `payment_events`. Additive. See `PAYMENTS.md`. |
| `0003_operations.sql` | Phase 4: month-end lease/retry columns, `job_runs`, EFT reservation setting (empty = off), payment review columns. Additive. See `OPERATIONS.md`. |
| `0004_launch_safety.sql` | Phase 5: shared `rate_limits`, `deployment_marker`, fraud flag ↔ payment link, Shopify checkout reservation setting (empty = off). Additive. |
| `0005_payment_provenance.sql` | Staging preparation: store, API version and test flag on each payment notification. Additive. |

Applying `0000`→`0005` to an empty database gives exactly the schema in
`lib/db/src/schema` (verified: same `pg_dump --schema-only` as a `drizzle-kit
push` of the current schema, apart from column order). The runner also creates
`schema_migrations` (one row per applied file, with its SHA-256).

Applied files are immutable: the runner refuses to continue if a recorded
file's checksum changed. A change is always a new, higher-numbered file, plus
an entry in `MARKERS` in `lib/db/scripts/migrate.mjs`.

## The runner

```sh
DATABASE_URL='postgres://…' pnpm --filter @workspace/db run migrate                 # dry run
DATABASE_URL='postgres://…' pnpm --filter @workspace/db run migrate -- --apply      # apply
```

- Uses `DATABASE_URL` only (no `NETLIFY_DATABASE_URL` fallback) and prints the
  target host/database (never the password) before doing anything.
- Without `--apply` it only reports what is applied and pending.
- Each file runs in its own transaction together with its `schema_migrations`
  row: a failing file is rolled back completely and the runner stops (later
  files are not run).
- An advisory lock stops two runners on one database at the same time.
- It refuses a database that already has the schema but no history, a pending
  migration whose objects already exist, and a `--baseline` that names a
  migration that is not actually in the database.

## Procedure (staging first, then production)

1. **Deploy order.** Migrate *before* deploying code that needs the new
   schema. All migrations so far are additive, so the currently deployed code
   keeps working on the migrated database.
2. **Back up.** On Neon / Netlify DB, create a branch or note the
   point-in-time-restore timestamp; otherwise
   `pg_dump --format=custom --file=masmila-$(date +%F-%H%M).dump "$DATABASE_URL"`.
   Confirm the backup exists before continuing.
3. **Pre-flight** (read-only):
   - 0001: the four queries in `FINANCIAL_INTEGRITY.md` → "Applying the migration" must each return 0.
   - 0003: nothing can conflict; every existing row already satisfies its
     checks (no payment event is resolved yet; the reservation setting starts
     empty). A month left `running` by the old code is picked up by the next
     scheduled run.
   - 0002: nothing can conflict (new sequence, new nullable column, new
     table). Check the names are free:
     ```sql
     select to_regclass('public.payment_events'), to_regclass('public.order_number_seq');  -- both null
     select count(*) from information_schema.columns where table_name = 'orders' and column_name = 'checkout_key';  -- 0
     ```
4. **Dry run** with `--environment <production|staging>` and read the target
   line, the pending list and the environment marker. A database that is
   already marked differently is refused.
5. **Apply** with `--apply --environment <production|staging>`, in a quiet
   period (0001 adds CHECK constraints and indexes, which briefly lock the
   tables they touch). The marker is written once and never changed by the
   runner. The application refuses to serve from a database marked for
   another environment, and also from an unmarked one, so mark it in this
   same run.
6. **Verify**: the dry run now shows nothing pending; place a test EFT order on
   staging and check its number looks like `MM-YYMMDD-00001`.
7. Deploy the code.

### Existing databases (created with `drizzle-kit push`)

A database created before this process has the schema but no
`schema_migrations`. Record what it already has as applied, then apply the
rest:

| The database has… | Run |
|---|---|
| the original schema only | `migrate -- --apply --baseline 0000_baseline` |
| also Phase 2 (`refunds` table exists — 0001 applied by psql or by the old Netlify push) | `migrate -- --apply --baseline 0001_financial_integrity` |
| also Phase 3 (`payment_events` exists) but no `schema_migrations` | `migrate -- --apply --baseline 0002_payment_integrity` |
| also Phase 4 (`job_runs` exists) but no `schema_migrations` | `migrate -- --apply --baseline 0003_operations` |

Do the dry run first (same flags without `--apply`). The runner checks that
each baselined migration really is present.

## Recovery and rollback limitations

- **Failure while applying:** that file is rolled back entirely; earlier files
  stay applied and recorded. Fix the cause (usually a pre-flight query that
  was not 0) and run again — it continues from the failed file.
- **There are no down-migrations.** To undo a migration, restore the backup
  taken in step 2. Restoring discards every write made after the backup
  (orders, payments, refunds, ledger rows), so the window between backup and
  restore must be accounted for by hand from Shopify, bank statements and the
  audit log.
- Because 0001 and 0002 are additive, the code *before* them runs on a
  migrated database: rolling back the **code** does not require rolling back
  the database. Prefer that.
- Removing 0002 by hand (only if it was never used):
  `drop table payment_events; drop index orders_checkout_key_uq; alter table orders drop column checkout_key; drop sequence order_number_seq; delete from schema_migrations where name = '0002_payment_integrity';`.
  Once real payments are recorded, `payment_events` is financial history —
  do not drop it.
- Removing 0003 by hand (tested): drop the constraints
  `payment_events_resolution_valid`, `payment_events_resolved_by_users_id_fk`
  and `settings_eft_reservation_hours_positive`. Then drop the columns
  `payment_events.resolved_at`, `resolved_by`, `resolution_action`,
  `resolution_reason`, `resolution_order_status`,
  `compensation_settings.eft_reservation_hours`, and `period_runs.lease_owner`,
  `lease_expires_at`, `attempts`, `last_error`, `started_at`, `finished_at`.
  Then `drop table job_runs; delete from schema_migrations where name = '0003_operations';`.
  Payment resolutions and run history are lost; Phase 3 code runs again.

## Who applies what, where

| Environment | Database | How its schema changes |
|---|---|---|
| Local / devcontainer | Its own (devcontainer: `db` service) | `push` by hand, or the migration runner |
| Replit workspace (development) | The workspace's development database | `push` by hand — never automatically (the post-merge hook no longer pushes) |
| Staging (Netlify deploy previews / branch deploys, or a Replit staging deployment) | Staging database | Migration runner, by a developer, before deploying |
| Production (Netlify production context, Replit production deployment) | Production database | Migration runner, by the person deploying, after a backup and a staging run of the same files |

The integration test databases are created with `createdb` plus the migration
runner.

## Keeping environments apart

- One database per environment: local/dev, staging, production. Never copy the
  production `DATABASE_URL` into a `.env` file, a devcontainer or the Replit
  workspace.
- Netlify: set `DATABASE_URL` per deploy context (Site configuration →
  Environment variables → "Different value for each deploy context").
  Production context → production database; Deploy previews and Branch deploys
  → staging. A preview build must never be able to reach production.
- Netlify DB (Neon) injects `NETLIFY_DATABASE_URL` for the site; the app falls
  back to it when `DATABASE_URL` is unset, the migration runner does not.
- Run migrations from a trusted machine with the target's URL set only for
  that command, not exported in a shell profile where other tools would pick
  it up.
- The integration tests refuse any database that is not on `localhost`.
