# Operations

Scheduled jobs, unpaid EFT reservations, client addresses and rate limits,
database timeouts and the payment review queue.

## Decisions needed from Mas'Mila

| # | Decision | Current behaviour until decided | Proposed |
|---|---|---|---|
| 1 | **How long an unpaid EFT order keeps its stock** | Never expires (as before) | **120 hours (5 days)** — covers the "1–2 business days" EFT clearing promised at checkout plus a weekend or public holiday. Set in Admin → Settings → "Unpaid EFT orders". |
| 2 | What to do when an EFT payment arrives **after** its order expired | Marking it paid is refused (the stock may be sold); the admin refunds the customer or places a new order for them | Confirm, or choose "re-open the order if stock is still available" (not built) |
| 3 | Whether **unfinished Shopify checkouts** (abandoned carts) should also expire | They keep their reservation indefinitely, as before (setting empty) | **24 hours**. Set in Admin → Settings → "Unpaid orders". A Shopify payment that arrives later is quarantined (`order_cancelled`) for a refund. |
| 4 | Month-end retry policy | 5 automatic attempts, waiting 15 min, 30 min, 1 h, 2 h… (max 6 h) between them; then an administrator runs it | Technical default; adjust if needed (`MONTH_END_MAX_ATTEMPTS`, `MONTH_END_RETRY_BASE_MS`) |

## Scheduled jobs

Two jobs, both in `lib/jobs.ts`, run together by `runDueJobs`:

- **Month-end qualification** for last month, and for any earlier month whose run failed or stalled.
- **Unpaid EFT expiry**: only when a reservation period is set (decision 1).

| Environment | Dependable trigger | Also runs |
|---|---|---|
| Netlify | Scheduled Function `scheduled-jobs`, hourly (`netlify.toml`). Runs only on the published production deploy. | — (no longer runs inside a customer's request at cold start) |
| Replit (autoscale) | A **Scheduled Deployment** running `pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run jobs` hourly — or any external cron running the `jobs` command | The server's hourly timer while an instance is awake (best effort: autoscaled instances sleep) |
| Local / devcontainer | `pnpm --filter @workspace/api-server run jobs` | The server's hourly timer |

All triggers may overlap; the database decides who works.

### How a month-end run stays safe

- **Lease.** The month's `period_runs` row is the lease: owner, expiry (10 min, renewed while working), attempt count, last error, start and end times. Only one runner owns a month; others return "skipped". An administrator's "Run qualification" uses the same lease (409 while a run is in progress).
- **Resumable.** Each reseller's rank change, snapshot and audit row are one transaction. A re-run judges a reseller from the rank recorded before the first attempt, so an interrupted month resumes without applying a promotion, warning or reversion twice.
- **Settlement only by the owner.** The incentive settlement and "closed" commit in one transaction that first checks this runner still owns the lease. A runner that timed out or was superseded rolls back and stops.
- **Failure.** The month is marked `failed` with the error, the attempt is recorded in `job_runs`, administrators are notified, and it is retried after the delay. A runner that crashes leaves its lease to expire and the next trigger takes over (the dead attempt is recorded as `abandoned`). A month whose last automatic attempt stalls is marked failed and raised once — it never sits in "running".
- **Visible.** Admin → Incentives & payouts → "Scheduled runs" lists each month's state and every attempt (trigger, status, start/end, error).

**Netlify limit:** scheduled functions stop after 30 seconds. A month that takes longer is cut off, resumes an hour later (lease expired) and makes progress each time, but completes faster from Replit or the `jobs` command. Watch "Scheduled runs" after the first live month-end.

## Unpaid EFT orders

- Expiry cancels an unpaid EFT order older than the reservation period and releases its reserved stock. One transaction per order, with the order locked. Inside the lock it checks that the order is still unpaid, still EFT, and older than the cutoff.
- A payment confirmed at the same moment wins. The order is then paid and never cancelled; the reverse is refused with 409. Tested with simultaneous payment confirmations and expiry runs.
- Each expiry is recorded as a cancellation with source `system`, key `expiry:<order id>`, and an audit row by `system:reservation-expiry`. Repeated or concurrent expiry runs cancel an order once.
- The customer is told the order was cancelled and to contact Mas'Mila if they already paid.
- While a period is set, the EFT payment instructions at checkout state it.
- Changing the period applies to existing unpaid orders at the next run.

## Client addresses and rate limits

Public write endpoints (checkout, applications, enquiries, newsletter, order
tracking) allow 20 requests per 10 minutes per client address. The address
comes only from what the deployment controls (`lib/client-ip.ts`).

| Deployment | Client address | Verified |
|---|---|---|
| Netlify | `x-nf-client-connection-ip`, set by Netlify's proxy; `X-Forwarded-For` ignored | Netlify's support staff name it the only client-IP header they support (community forum, not product docs). Netlify is assumed to overwrite any client-sent value — check once with the diagnostic below. |
| Long-running server (Replit, local) | The TCP peer, or with `TRUSTED_PROXY_HOPS=n` the address *n* hops from the right of `X-Forwarded-For` | **Replit's proxy chain is not documented** — not configured |

`trust proxy` is never `true`, so a visitor can no longer pick their own
address (and a fresh allowance) by sending `X-Forwarded-For`.

**Replit: set `TRUSTED_PROXY_HOPS` after verifying it.** Until then every
visitor behind Replit's proxy shares one allowance (20 checkouts per 10
minutes in total), and production logs `config.proxy_untrusted` at start.

To verify:

1. Deploy.
2. Sign in as an administrator and open `/api/admin/diagnostics/client-ip` from a known network.
3. Find your public IP in `forwardedFor`.
4. Set `TRUSTED_PROXY_HOPS` to its position counted from the right (usually 1).
5. Redeploy and check that `clientIp` now shows your address.

The counts are kept in the database (`rate_limits`, one atomic upsert per
request), so every instance and every Netlify function invocation shares the
same allowance. Only a hash of address and endpoint is stored, never the
address itself. Old counters are pruned by the scheduled jobs. If the database
is unavailable the request gets 503; the limit is never skipped.

## Database timeouts

Every transaction sets its own limits (`SET LOCAL`, which works through Neon's
pooled endpoint and PgBouncer; connection-time parameters do not):

| Setting | Default | Env override |
|---|---|---|
| Statement timeout | 15 s | `DB_STATEMENT_TIMEOUT_MS` |
| Lock wait timeout | 10 s | `DB_LOCK_TIMEOUT_MS` |
| Idle inside a transaction | 15 s (server ends the transaction, releasing its locks) | `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` |
| Wait for a free pool connection | 10 s | `DB_CONNECTION_TIMEOUT_MS` |

Defaults are about 10× the slowest statements measured across the integration
suites. The slowest were stock-reservation updates waiting on a row lock: up
to 0.98 s with 50 simultaneous checkouts of one product. Everything else stayed
under about 0.22 s.

A timeout or lost connection rolls the transaction back and returns `503`
("nothing was changed, please try again") with `Retry-After`, logged as
`db.unavailable`. Shopify retries a webhook that got a 503.

A connection the server closes is discarded by the pool, and later requests
work normally. Previously this crashed the process with an unhandled error.

Statements outside a transaction (simple reads, single updates) get the
statement and lock limits as session settings, set on every new connection
before it is used.

Through a transaction-mode pooler (Neon's pooled endpoint), a session setting
may not reach every server connection. For full coverage there, also set role
defaults once, as the database owner:
`ALTER ROLE <app role> SET statement_timeout = '15s'; ALTER ROLE <app role> SET lock_timeout = '10s';`

## Environment isolation

Each database is marked with the environment it belongs to (`deployment_marker`,
set once with `migrate --environment`). Each deployment knows its own
environment:

- **Netlify:** from the deploy context, baked in at build time. `production` is
  production; deploy previews and branch deploys are staging.
- **Replit / elsewhere:** from `DEPLOY_ENVIRONMENT`.

A deployment connected to a database marked for another environment answers
every API request with 503, writes nothing (not even base data), and its
scheduled jobs refuse to run. This is checked on the first request and
re-checked if the database was unreachable.

The guard stops the *application* from using the wrong database. It does not
stop a misconfigured preview from opening a connection, so per-context
`DATABASE_URL` values are still required.

## Preflight

`pnpm --filter @workspace/api-server run preflight`, run with the target
environment's variables, checks the configuration and the database without
changing anything or printing secrets. It covers:

- production mode, deployment environment and Clerk keys;
- every required variable;
- forbidden demo flags;
- Shopify variables and webhook secret;
- email;
- proxy hops;
- database reachable;
- every migration applied with a matching checksum;
- environment marker;
- no demo accounts;
- **every Shopify variant price equal to the storefront price** (Storefront API, ZA buyer context).

Exit code 1 if anything fails. Run it on staging, then production, before
opening the site.

## Payment review (quarantined payments)

Admin → **Payment review** lists Shopify payments that did not match their
order (see `PAYMENTS.md`).

- **Filters:** awaiting review / resolved / all quarantined / all notifications, rejection reason, and order number or Shopify order.
- **Investigate** shows what you need to reconcile in Shopify and the bank:
  - Shopify order and payment status, amount and currency, order total and the difference
  - why it was rejected, the order's current state
  - other payment notifications for the same order
  - the review history
- No customer contact details or secrets are shown.

**Resolve** records what you did: refunded in Shopify / confirmed (order
already marked paid from Orders) / no action required / other.

- A reason (at least 5 characters) is required.
- The resolution stores the administrator, the time, the order's status at that moment and the original outcome. It writes an audit row (`payment_event_resolved`) in the same transaction.
- A payment can be resolved once; a second attempt gets 409.
- Resolving **never** marks an order paid, changes stock or incentives, or moves money.
- "Confirmed — order marked paid" is only accepted once the order is already paid.
- Every endpoint is administrator-only on the server (`requireAdmin`).

The fraud flag raised for that payment (`payment_rejected`) is closed in the
same transaction and listed in the audit row. Flags raised before migration
0004 are not linked to their payment and are still resolved in Fraud & abuse.

## Logs to alert on

| `event` | Meaning |
|---|---|
| `job.failed` | Month-end attempt failed or stalled (admins also notified) |
| `job.lease_lost` | A runner was superseded (normal after a crash or timeout; investigate if frequent) |
| `expiry.failed` | An order could not be expired (retried next run) |
| `db.unavailable` | Timeout or lost connection (a 503 was returned) |
| `webhook.shop_mismatch` | A signed webhook from a store other than `SHOPIFY_STORE_DOMAIN` (401) — check which store calls this URL |
| `config.proxy_untrusted` | Replit/long-running server without `TRUSTED_PROXY_HOPS` |
| `payment.review_resolved` | A quarantined payment was resolved (informational) |
