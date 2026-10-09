# Staging setup and validation

How to provision, configure and validate the Mas'Mila staging environment,
and the record in which the staging tests (S1–S15) are executed.

**Status (9 October 2026): Blocked — missing access.** The code is ready to
be configured for staging, but none of the resources R1–R10 exists and there
is no access to Netlify, Clerk, Shopify or a staging database. B1–B6 and
S1–S15 are therefore all **Blocked**, not run. The commands in section 5 were
rehearsed against a local database and server to prove they work as written;
that rehearsal is **not** staging evidence. Nothing has been deployed, and the
launch decision stays **Blocked**.

Who does what:

- **Owner:** the project owner, who provisions accounts and credentials.
- **Tester:** whoever executes the tests. This can be the owner or a developer
  with staging access.
- **Client:** Mas'Mila, who witnesses and signs off the acceptance items.

---

## 0. What to do first (priority order)

Each step needs the ones before it. "Who" is the person with the access; the
developer can do nothing in this list without it.

| Priority | Action | Who | Needs | Unblocks |
|---|---|---|---|---|
| 1 | Decide D5 (separate Shopify development store) and D8 (administrator mailbox). Approve this plan. | Client | — | 2–6 |
| 2 | **R1** staging database (new, empty; not a copy of production). Give the developer the **direct** connection string through a password manager. | Owner | Database provider account | Migration, S12, S14, S15 |
| 3 | **R3** Clerk development instance (email verification on; MFA for admins) | Owner | Clerk account | S1, deployment |
| 4 | **R4** Shopify development store; enable the test gateway. **R5** Storefront access token. | Owner | Shopify Partner account | S2–S6, price check |
| 5 | **R9** six test mailboxes, **R10** access (Netlify logs, Shopify admin, a trusted machine for the commands) | Owner | — | All S-tests |
| 6 | **R2** Netlify staging context: enter section 2's variables on Deploy previews / Branch deploys only | Owner | Netlify site admin; 2–4 done | Deployment |
| 7 | Migrate and mark R1 as staging; preflight (section 5, C1–C3) | Developer or owner | 2, 6 | Deployment |
| 8 | Authorise and deploy the reviewed commit to the **staging** context only | Owner (explicit authorisation) | 7 passes | S-tests |
| 9 | **R7** staging products and variant ids; **R6** webhooks (including the `?copy=2` subscription for S4) | Owner + developer | 8 (the URL must exist) | S2–S6, price check |
| 10 | **R8** email (optional) | Owner | Resend account, verified domain | Email parts of S1/S9/S10 |
| 11 | Run B1–B6, then S1–S15 in order, with evidence | Tester; client witnesses S1, S2, S5–S8, S10, S11 | 1–10 | Exit condition |

### What can be done locally and what cannot

| Step | Locally (no external access) | Needs access or approval |
|---|---|---|
| Code, tests, builds | Done: 46 unit, 98 integration, production build | — |
| Command syntax (migrate, preflight, evidence, curl checks) | Done: rehearsed on a local staging-marked database and local production-mode server (section 5) | — |
| Create R1–R10 | — | Owner: database provider, Clerk, Shopify Partner, Netlify, Resend |
| Enter staging variables | — | Owner: Netlify site admin |
| Migrate and mark the staging database | Command ready | Staging `DATABASE_URL` (R1) |
| Staging preflight | Command ready | All section 2 values |
| Deploy to staging | Build verified locally | Owner's explicit authorisation; Netlify |
| S1–S15, B1–B6 | Not possible: local runs are not evidence | Staging deployment + R1–R10 |
| D1–D10, AC1–AC10 sign-off | — | Client |

## 1. Resources to provision (owner)

Each item is separate from production. **Do not** reuse a production
account, key, store or database for staging.

| # | Resource | What to create | Notes |
|---|---|---|---|
| R1 | **Staging database** | A new PostgreSQL database (e.g. a new Neon project, or a new empty database in an existing project). Note its **pooled** and **direct** connection strings. | Must be empty and must **not** be a branch or copy of production: that would copy customer data into staging, and it would carry the production marker. |
| R2 | **Netlify staging context** | On the existing Netlify site, use **Deploy previews** and/or a **Branch deploy** (e.g. branch `staging`) as the staging context. | Netlify environment variables can have a different value per deploy context; the staging values below go on the Deploy previews / Branch deploys contexts only. |
| R3 | **Clerk development instance** | A separate Clerk application, or the development instance of the existing one. Keys start `sk_test_` / `pk_test_`. | Enable email verification. Enable MFA for administrators to rehearse D8. |
| R4 | **Shopify development store** | A Shopify development store (Partner account) for staging only, e.g. `masmila-staging.myshopify.com`. Payments: Shopify's test gateway (Bogus Gateway) or the payment provider's test mode. | **Never** the live store. Staging accepts only test payments and refuses webhooks from any other store (section 3). |
| R5 | **Shopify Storefront API access** on the development store | A Storefront access token: Headless sales channel, or a custom app with Storefront API access that may read products and create carts. | Goes in `SHOPIFY_STOREFRONT_TOKEN`. |
| R6 | **Shopify webhooks** on the development store | Subscriptions to `orders/paid`, `orders/cancelled` and `refunds/create`, pointing at `https://<staging-url>/api/webhooks/shopify`, JSON format, API version **2026-10** (the version the payload handling was checked against). | Note the signing secret. Webhooks created in Settings → Notifications show the store's signing key there; for an app subscription it is the app's client secret. |
| R7 | **Staging products** in the development store | One Shopify product variant per storefront product used in tests, **priced exactly like the storefront** (ZAR, VAT-inclusive retail price). Delivery rates per D4. | Each variant's id (`gid://shopify/ProductVariant/…`) is entered on the matching product in the staging admin (Products → Shopify variant ID). |
| R8 | **Email (optional for staging)** | A Resend API key and a sending address on a verified domain, or leave email off. | Without it, S1/S9/S10 check in-app notifications instead of email. |
| R9 | **Test identities** | Six mailboxes you control (e.g. `owner+s-admin@…`, `+s-customer@…`, `+s-tl@…`, `+s-manager@…`, `+s-reseller@…`, `+s-applicant@…`). | Synthetic people only — never real customers. |
| R10 | **Access** | Someone who can read Netlify function logs for the staging deploy, open the Shopify development store admin, and run commands with the staging `DATABASE_URL` (direct connection) from a trusted machine. | Needed for evidence. |

## 2. Staging environment variables

Set on the Netlify **Deploy previews** and **Branch deploys** contexts (or the
staging Replit deployment). Never put staging values on the Production
context, or production values on staging. "Secret" values are pasted into
Netlify only, never into chat, tickets or the repository.

| Variable | Staging value | Secret | Checked by |
|---|---|---|---|
| `DATABASE_URL` | R1 **pooled** connection string | yes | preflight: reachable, migrated, marked `staging` |
| `SITE_URL` | The staging URL, e.g. `https://staging--<site>.netlify.app` | no | preflight |
| `ADMIN_EMAILS` | The R9 administrator mailbox | no | preflight (fail if empty) |
| `CLERK_SECRET_KEY` | R3 `sk_test_…` | yes | preflight: **fails if `sk_live_`** on staging |
| `CLERK_PUBLISHABLE_KEY` | R3 `pk_test_…` | no | preflight: format |
| `VITE_CLERK_PUBLISHABLE_KEY` | Same as `CLERK_PUBLISHABLE_KEY` (used at build time) | no | preflight: equality |
| `SHOPIFY_STORE_DOMAIN` | R4 `<name>.myshopify.com` (not a custom domain) | no | preflight: format; webhooks from any other store get 401 |
| `SHOPIFY_STOREFRONT_TOKEN` | R5 token | yes | preflight: variant prices readable |
| `SHOPIFY_WEBHOOK_SECRET` | R6 signing secret | yes | preflight: present; every webhook verified with it |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | R8, or unset | yes / no | preflight: warning if unset |

Netlify sets the deploy context at build time: deploy previews and branch
deploys run as **staging** automatically.

**Replit staging only:**

| Variable | Value |
|---|---|
| `DEPLOY_ENVIRONMENT` | `staging` |
| `TRUSTED_PROXY_HOPS` | Only after S13 shows the right value |

**Must not be set on staging:** `DEMO_AUTH`, `SEED_DEMO_DATA`, `MAINTENANCE_MODE`
(except during S12), `SHOPIFY_ALLOW_TEST_ORDERS` (no effect in a deployment;
preflight warns).

Not needed: `NODE_ENV` (Netlify functions are always built in production
mode).

## 3. Isolation guarantees (what stops staging touching production)

| Risk | Control | Verified |
|---|---|---|
| Staging writes to the production database | Each database carries an environment marker (set once by the migration runner, which refuses to change it). A staging deployment that finds a `production` marker, or none, answers every API request with 503 and writes nothing — not even base data. Its scheduled jobs refuse too. | Locally: a deploy-preview **built bundle** against a production-marked database → 503 on every request; the production bundle → 200 (`launch` L6, startup suite). On staging: **S14**. |
| A preview silently gets a copy of production (e.g. a database branch) | A branch of production carries the `production` marker, so the preview refuses to serve | Same control; S14 |
| Staging signs in production users | Preflight fails a staging context with a live Clerk key (`sk_live_`) | Locally (`launch` L8, unit tests); S15 |
| Staging takes real money | Staging settles **only Shopify test payments**. A live (real-money) payment that reaches staging is quarantined (`live_payment_in_staging`) and raised to administrators; it never marks an order paid or creates incentives. | Unit tests; on staging: **S2** (test payment applied, evidence `test_payment = true`) |
| The live store's webhooks reach staging | Webhooks are accepted only if signed with the staging secret **and** sent by the configured store (`X-Shopify-Shop-Domain`); otherwise 401, nothing recorded | Locally: payments suite A9. On staging: S3 negative check |
| Production accepts test payments | The production deployment rejects every Shopify test payment (`test_payment`) | Unit tests |
| Real payouts | The platform has **no bank or payout integration**: its only outbound calls are email (Resend) and the Shopify Storefront API. "Paid" on a payout only records what an administrator did elsewhere. On staging use fake references (`STAGING-BATCH-1`) and never act on them at a bank. | Code inspection |
| Schema pushed automatically | No build, hook or start-up changes a schema; `drizzle-kit` refuses inside Netlify builds and Replit deployments | `edge-safety` tests |

What the controls cannot stop: someone entering production credentials into
the staging context by hand. Preflight catches the Clerk key and the database
marker; it cannot tell a live Shopify store from a development store by its
token. The store check and the test-payments-only rule stop money moving
through staging, but the store itself would still be the live one. Review the
context's variables before each staging run.

## 4. Setup procedure (owner, then tester)

Run from a trusted machine with the repository checked out. Never on the
production database.

1. **Provision** R1–R10.
2. **Netlify variables:** set section 2's values on the Deploy previews and
   Branch deploys contexts. Check the Production context still has
   production values (or none yet).
3. **Migrate the staging database** with its **direct** connection string:
   ```sh
   DATABASE_URL='<R1 direct URL>' pnpm --filter @workspace/db run migrate -- --environment staging
   # read: target is the staging host/database, 0000…0005 pending, environment marker (none)
   DATABASE_URL='<R1 direct URL>' pnpm --filter @workspace/db run migrate -- --apply --environment staging
   DATABASE_URL='<R1 direct URL>' pnpm --filter @workspace/db run migrate -- --environment staging
   # read: pending (none), environment marker staging
   ```
   Then set the role defaults (as the database owner):
   `ALTER ROLE <app role> SET statement_timeout = '15s'; ALTER ROLE <app role> SET lock_timeout = '10s';`
4. **Preflight** with the staging context's values exported in the shell
   (not committed, not pasted anywhere):
   ```sh
   NODE_ENV=production DEPLOY_ENVIRONMENT=staging DATABASE_URL=… SITE_URL=… ADMIN_EMAILS=… \
   CLERK_SECRET_KEY=… CLERK_PUBLISHABLE_KEY=… VITE_CLERK_PUBLISHABLE_KEY=… \
   SHOPIFY_STORE_DOMAIN=… SHOPIFY_STOREFRONT_TOKEN=… SHOPIFY_WEBHOOK_SECRET=… \
   pnpm --filter @workspace/api-server run preflight
   ```
   Required: 0 failed. The Shopify price check fails until R7 is done and the
   variant ids are entered (step 7). Re-run it then.
5. **Deploy** the staging branch, or open a deploy preview, from the
   **reviewed** commit. Nothing is committed or deployed by this
   documentation; the owner decides when.
6. **First sign-in:** sign in with the administrator mailbox → `/admin` must
   open.
7. **Catalogue:** production mode seeds no products. Create the test products
   in Admin → Products with the same prices as the R7 variants, and enter each
   variant id. Re-run preflight: the Shopify price check must pass.
8. **Settings:** for S10, set Admin → Settings → "Unpaid orders": EFT
   **1 hour**, Shopify checkouts **1 hour**. These staging-only values are
   not decisions D1/D3.
9. **Shopify webhooks (R6):** create the three subscriptions now that the URL
   exists. For S4, also create a second `orders/paid` subscription to
   `https://<staging-url>/api/webhooks/shopify?copy=2` (the query string is
   ignored by the app).
10. Start the execution record (section 6).

### Backup and rollback rehearsal on staging

Rehearse the production procedure (`LAUNCH_READINESS.md` §7) here first:

| Step | Action | Expected |
|---|---|---|
| B1 | Before deploying a new build to staging: create a backup (Neon branch / restore point of R1) and record its name and time | Backup listed by the provider |
| B2 | Run the migration dry run; record the output | Nothing pending (or exactly the new migration) |
| B3 | Code rollback: publish the previous staging deploy | Site works; no data lost (migrations are additive) |
| B4 | Data rollback rehearsal: set `MAINTENANCE_MODE=true` on staging, redeploy, place a test order | The order request gets 503 "offline for maintenance"; `/api/healthz` 200 |
| B5 | Restore R1 from the B1 backup into a **new** database; point staging at it; run preflight | Preflight passes (marker `staging` restored with the data); orders after B1 are absent, as expected |
| B6 | Remove `MAINTENANCE_MODE`, redeploy | Normal service |

## 5. Command sheet

Run from the repository root in Git Bash (or any POSIX shell) on a trusted
machine. Secret values are typed at hidden prompts, so they never appear on
screen, in shell history or in this document. Run `unset` (C7) when done.

**C0. Load the staging values for this shell only**
```sh
read -rs -p "Staging DATABASE_URL (R1, DIRECT connection): " DATABASE_URL; echo; export DATABASE_URL
read -rs -p "CLERK_SECRET_KEY (sk_test_…): " CLERK_SECRET_KEY; echo; export CLERK_SECRET_KEY
read -rs -p "SHOPIFY_STOREFRONT_TOKEN: " SHOPIFY_STOREFRONT_TOKEN; echo; export SHOPIFY_STOREFRONT_TOKEN
read -rs -p "SHOPIFY_WEBHOOK_SECRET: " SHOPIFY_WEBHOOK_SECRET; echo; export SHOPIFY_WEBHOOK_SECRET
export NODE_ENV=production DEPLOY_ENVIRONMENT=staging
export CLERK_PUBLISHABLE_KEY='pk_test_…' VITE_CLERK_PUBLISHABLE_KEY='pk_test_…'   # same value, not secret
export SITE_URL='https://<staging-url>' ADMIN_EMAILS='<admin mailbox>' SHOPIFY_STORE_DOMAIN='<name>.myshopify.com'
```

**C1. Migration (setup step 3)**
```sh
pnpm --filter @workspace/db run migrate -- --environment staging           # dry run: check the target line and "marker (none)"
pnpm --filter @workspace/db run migrate -- --apply --environment staging   # apply 0000–0005 and mark "staging"
pnpm --filter @workspace/db run migrate -- --environment staging           # expect: pending (none), marker staging
```
The runner prints the host/database name only, never the password. If it
says the database is marked `production`, **stop**: wrong `DATABASE_URL`.

**C2. Role defaults (once, as the database owner, in the provider's SQL console)**
```sql
ALTER ROLE <app role> SET statement_timeout = '15s';
ALTER ROLE <app role> SET lock_timeout = '10s';
```

**C3. Preflight (setup steps 4 and 7; S15)**
```sh
pnpm --filter @workspace/api-server run preflight
```
Required: `0 failed`. The output contains no secrets; paste it into S15.

**C4. Deployment verification (after setup step 8)**
```sh
STAGING_URL='https://<staging-url>'
curl -s -o /dev/null -w "%{http_code}\n" "$STAGING_URL/api/healthz"                               # V1 expect 200
curl -s "$STAGING_URL/api/store-config" | grep -o '"authMode":"[a-z]*"'                           # V2 expect "authMode":"clerk"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer demo:admin@masmila.co.za" "$STAGING_URL/api/admin/summary"   # V3 expect 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -H "X-Shopify-Topic: orders/paid" -d '{}' "$STAGING_URL/api/webhooks/shopify"   # V4 expect 401
curl -s -o /dev/null -w "%{http_code}\n" "$STAGING_URL/api/admin/payment-events"                 # V5 expect 401
```
V6 (part of S14) is the same V1 call against a preview whose `DATABASE_URL`
points at a production-marked database: expect 503 for every `/api` path.

**C5. Evidence for the record (after each test)**
```sh
mkdir -p staging-evidence/$(date +%F)
pnpm --filter @workspace/api-server run staging-evidence -- --limit 30 > staging-evidence/$(date +%F)/S<n>.md
pnpm --filter @workspace/api-server run staging-evidence -- --order MM-YYMMDD-NNNNN --limit 30 > staging-evidence/$(date +%F)/S<n>-order.md
```
Keep `staging-evidence/` outside the repository (or never commit it).

**C6. Backup point (B1)** — create it in the database provider's console and
write its name and time in the record. The tool does not do this.

**C7. Clear the shell when finished**
```sh
unset DATABASE_URL CLERK_SECRET_KEY SHOPIFY_STOREFRONT_TOKEN SHOPIFY_WEBHOOK_SECRET CLERK_PUBLISHABLE_KEY VITE_CLERK_PUBLISHABLE_KEY SITE_URL ADMIN_EMAILS SHOPIFY_STORE_DOMAIN NODE_ENV DEPLOY_ENVIRONMENT
```

**Rehearsal of these commands (9 October 2026, local only — not staging evidence)**

Run against a local throwaway database and a local production-mode server
with staging settings and fake, correctly formatted keys.

| Command | Local result |
|---|---|
| C1 dry run / apply / verify | Pending 0000–0005 / applied, marked `staging` / pending none, marker staging |
| C1 with `--environment production` on that database | Refused: "marked staging, not production" (exit 1) |
| C5 | All report sections printed; read-only |
| V1 / V2 / V3 / V4 / V5 | 200 / `"authMode":"clerk"` / 401 / 401 / 401 |
| V6 (same server settings, production-marked database) | `/api/healthz` 503, `/api/products` 503 |
| C3 | Rehearsed in the previous phase: 0 failed with complete settings; fails with a live Clerk key on staging |

## 5a. Collecting evidence

- `pnpm --filter @workspace/api-server run staging-evidence -- [--order MM-…] [--limit 30]`
  with the staging `DATABASE_URL` prints Markdown tables to paste into the
  record. It's read-only and prints no customer contact details or secrets:
  payment notifications (with provenance), refunds, an order's incentive
  ledger and stock, payouts with ledger totals, month-end runs, job runs,
  review queues, audit log.
- A payment notification counts as **provider evidence** only if its
  provenance shows `shopify:<staging store>` (store and API-version headers,
  recorded after the signature and store checks passed) **and** the same
  Shopify order (number, id, total, test badge) exists in the development
  store's admin. A payload made by hand and signed with the secret is not
  evidence: it has no matching order in Shopify. Local test runs are always
  `unverified`.
- Screenshots: Shopify order page (order number, total, "Paid", test badge),
  the admin screen in question, Netlify function log lines with their
  timestamps.
- Store evidence under `staging-evidence/<date>/S<n>/` outside the
  repository; link it in the record.

## 6. Execution record (S1–S15)

Status values: **Not run**, **Pass** (all evidence attached), **Fail**
(attach evidence and open a defect), **Blocked** (state why and the remaining
risk). While a test is blocked, its risk is whatever the test would have
shown: the local evidence noted in `LAUNCH_READINESS.md` §2 is the only
assurance, and it never counts as a staging Pass. A test is Pass
only when every listed evidence item exists. A local test run never makes a
staging test Pass.

### S1 — Clerk sign-in and role-based access
- **Who:** tester, with the R9 mailboxes.
- **Steps:**
  1. Sign up all six identities through the staging site (email verification
     required).
  2. Apply as a reseller with the manager, team leader and reseller
     identities, in that order. The team leader applies with the manager's
     referral code, and the reseller with the team leader's. The
     administrator approves each.
  3. In Admin → Resellers, the administrator sets the manager's rank to
     Manager and the team leader's to Team Leader, and **locks** both ranks.
     Approval creates plain resellers; leadership ranks normally come from
     month-end qualification, which staging's small volumes would revert in
     S9 if not locked.
  4. Each identity opens `/account`, `/account/reseller`, `/admin`.
  5. As a signed-out visitor, call `GET /api/admin/summary`.
- **Expected:**
  - Customer: account only; the reseller portal says "approved resellers only"; admin refused.
  - Resellers: portal, but no admin.
  - Administrator: everything.
  - Signed out: 401.
  - The administrator alone can approve applications.
- **Evidence:** screenshots per identity; `staging-evidence` audit section showing `reseller_application_approved` and the rank changes.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S2 — Customer purchase through the Shopify test checkout
- **Who:** tester. **Preconditions:** R4–R7, setup step 7, preflight 0 failures.
- **Steps:**
  1. As the customer, add two test products to the bag and choose Shopify
     checkout.
  2. Pay with the test gateway (Bogus Gateway's "successful" test card, per
     Shopify's test documentation).
  3. Return to the site.
- **Expected:**
  - Redirected to the development store's checkout with the storefront total.
  - After paying: the Shopify order is "Paid" and marked as a test order.
  - Within a minute, the staging order is **paid** and its stock deducted.
  - The customer sees it as paid in their account.
- **Evidence:**
  - Shopify order page: order name, id, total, test badge.
  - `staging-evidence --order <MM-number>`: a payment notification with
    `outcome applied`, `provenance shopify:<store>`, `test_payment true`, and
    `amount` = order total; the stock row.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S3 — Genuine webhook signature and payload
- **Who:** tester (Netlify variables access needed). **Precondition:** S2.
- **Steps:**
  1. Confirm the S2 notification's `shopify_order_id` and `shopify_order`
     equal the order in the Shopify admin, and its `delivery_id` is present.
  2. **Negative:** set `SHOPIFY_WEBHOOK_SECRET` on the staging context to a
     wrong value, redeploy, and place another test order. Its webhook must be
     refused, and the order stays awaiting payment.
  3. Restore the right secret and redeploy. Shopify's retry (or the next
     order) is then applied.
  4. **Store check:** compare `SHOPIFY_STORE_DOMAIN` with the provenance shown.
- **Expected:**
  - Step 1: everything matches.
  - Step 2: Netlify log shows `webhook.signature_invalid` (401); no new
    payment notification.
  - Step 3: `applied`.
  - Step 4: identical.
- **Evidence:** both Shopify order pages; log lines for 401 and 200; `staging-evidence` rows.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). *This test, not any local run, is what verifies real signatures and payload fields.*

### S4 — Duplicate delivery
- **Who:** tester. **Precondition:** the second `orders/paid` subscription (setup step 9).
- **Steps:** place a test order. Shopify delivers `orders/paid` to both
  subscriptions: two deliveries with different delivery ids for the same
  payment.
- **Expected:** one notification recorded, outcome `applied`. The second
  delivery is answered `duplicate` (Netlify log: `payment.duplicate_delivery`).
  Stock deducted once; incentives once.
- **Evidence:** Netlify log lines for both deliveries; `staging-evidence --order` (one notification, one set of ledger rows).
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). If Shopify does not allow the second subscription, record **Blocked** with the error shown; the de-duplication then remains verified locally only.

### S5 — Payment mismatch quarantine
- **Who:** tester.
- **Steps:**
  1. Create a fixed discount code in the development store.
  2. Place a test order through the staging checkout and apply the code at
     Shopify checkout. Pay with the test gateway.
- **Expected:** the notification is `rejected` with reason `underpayment`. The
  order stays awaiting payment, with no incentives. A `payment_rejected` fraud
  flag is raised and administrators are notified.
- **Evidence:** Shopify order page (discounted total); `staging-evidence --order` (rejected, amounts, review "awaiting review"); Admin → Payment review screenshot.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S6 — Cancellation and refund from Shopify
- **Who:** tester.
- **Steps:**
  1. Paid S2 order: refund one line item in the Shopify admin (test refund).
  2. A new test order that is paid: cancel it in the Shopify admin.
  3. An unpaid order whose Shopify checkout was abandoned: cancel the Shopify
     order if one exists.
- **Expected:**
  - Step 1: refund recorded (source `shopify`), the order partially refunded;
    incentive reversal only if the order carried incentives.
  - Step 2: cancelled; stock restored.
  - Every event appears once.
- **Evidence:** Shopify refund/cancel pages; `staging-evidence --order` per order (refunds, ledger, stock).
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S7 — Commission accrual and reversal
- **Who:** tester (the S1 identities).
- **Steps:**
  1. As the reseller (sponsor: team leader, under the manager), place the
     opening order of 10 bottles by EFT.
  2. The administrator marks it paid.
  3. The administrator records a return of 2 bottles.
- **Expected:**
  - After payment: Team Leader 5% and Manager 2% of the wholesale value,
    pending.
  - After the return: reversals of exactly 2/10 of each.
  - The reseller portal and Admin → Incentives agree.
- **Evidence:** `staging-evidence --order <MM-number>` before and after the return; incentive screenshots.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S8 — Payouts (no real transfer)
- **Who:** tester as administrator.
- **Steps:**
  1. Run qualification for the month.
  2. Approve the team leader's incentives.
  3. Click "Create payouts" twice quickly.
  4. Approve → processing (reference `STAGING-BATCH-1`) → paid.
  5. Try to skip a step on another payout.
  6. As the team leader, try any admin payout action.
- **Expected:**
  - One payout, whose amount equals its ledger total.
  - Each step recorded with the administrator.
  - Skipping refused (409).
  - Reseller refused (403).
  - No money moves anywhere.
- **Evidence:** `staging-evidence` payouts table (amount = ledger_total), audit lines `payout_*`, screenshots.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S9 — Month-end scheduling, retry and alerts
- **Who:** tester (Netlify logs access).
- **Steps:**
  1. After the deploy, wait for the next full hour.
  2. Check the `scheduled-jobs` function log.
  3. Check Admin → Incentives → Scheduled runs.
  4. Optional failure rehearsal: point a branch deploy at a staging database
     copy whose `period_runs` row for last month is `failed` with
     `run_at` > 1 h ago, and watch it retry.
- **Expected:** the function runs hourly and logs `jobs.scheduled_finished`.
  Last month is `closed` (or `skipped` with reason `no_resellers` on a fresh
  database — then run qualification manually once and confirm it shows as an
  `admin` run). A failure shows `failed`, the attempt count, and an
  administrator notification.
- **Evidence:** function log lines (timestamps an hour apart), Scheduled runs screenshot, `staging-evidence` month-end and job tables.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). Netlify's 30-second scheduled-function limit is observed here: record the run duration.

### S10 — Reservation expiry and stock
- **Who:** tester. **Precondition:** setup step 8 (1 hour each).
- **Steps:**
  1. As the customer, place an EFT order (3 bottles) and leave it unpaid for
     over an hour.
  2. Place a second EFT order; the administrator marks it paid within the
     hour.
  3. Leave a Shopify checkout unpaid for over an hour.
- **Expected:**
  - After the next hourly run: order 1 cancelled with source `system`; its
    reservation released; the customer notified.
  - Order 2 paid and untouched.
  - The Shopify order is cancelled.
  - Marking order 1 paid afterwards is refused (409).
- **Evidence:** `staging-evidence --order` for each (refunds row `expiry:<id>`, stock), notification screenshot.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). Real business values for D1/D3 still need sign-off.

### S11 — Payment review: investigation and audited resolution
- **Who:** tester as administrator. **Precondition:** S5.
- **Steps:**
  1. Admin → Payment review → open the S5 event.
  2. Refund the difference in Shopify (test refund).
  3. Record "Refunded in Shopify" with a reason.
  4. Try to resolve it again.
  5. As a non-admin, call `GET /api/admin/payment-events`.
- **Expected:**
  - The investigation view shows the Shopify order, amount, expected total,
    difference and reason, with no customer contact details.
  - Resolution recorded with administrator and time; its fraud flag closed.
  - Second attempt: 409.
  - Non-admin: 403/401.
  - The order is not marked paid by the resolution.
- **Evidence:** screenshots; `staging-evidence` (review = refunded_in_shopify; audit `payment_event_resolved`; open flag count down).
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026).

### S12 — Timeouts and temporary database unavailability
- **Who:** tester (database provider console).
- **Steps:**
  1. Suspend or pause the R1 compute for about a minute, if the provider
     allows it.
  2. Meanwhile load the shop and place an order.
  3. Resume and repeat.
- **Expected:**
  - While unavailable: 503 "nothing was changed"; Netlify log `db.unavailable`.
  - After resuming: normal service without a redeploy.
  - No half-created order.
- **Evidence:** log lines; `staging-evidence` (no orphan order).
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). If the provider has no suspend, record **Blocked (provider)**; it is verified locally only.

### S13 — Client IP and rate limiting behind the real proxy
- **Who:** tester as administrator.
- **Steps:**
  1. Open `/api/admin/diagnostics/client-ip` from a network whose public IP
     you know.
  2. Repeat the request with your own `x-nf-client-connection-ip: 203.0.113.9`
     and `X-Forwarded-For: 203.0.113.9` headers (e.g. with curl, adding your
     session cookie).
  3. Submit the newsletter form 21 times within 10 minutes, with rotating
     `X-Forwarded-For` values.
- **Expected:**
  - Step 1: `clientIp` equals your public IP.
  - Step 2: `clientIp` unchanged.
  - Step 3: the 21st request is answered 429.
- **Evidence:** diagnostic JSON (mask the IP in shared copies), the 429 response.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). *Confirms Netlify overwrites `x-nf-client-connection-ip`; unverified until this passes.*

### S14 — A preview cannot use the production database
- **Who:** owner. **Precondition:** a production database exists and is marked `production`. If not yet, use a throwaway database marked `production`.
- **Steps:**
  1. Open a deploy preview whose `DATABASE_URL` points at that
     production-marked database.
  2. Load `/api/healthz` and `/api/products`, and submit the newsletter form.
- **Expected:** every API request 503; Netlify log `config.database_environment`; no row written (row counts unchanged).
- **Evidence:** responses, log line, row counts before and after.
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). Afterwards restore the preview's staging `DATABASE_URL`.

### S15 — Preflight
- **Who:** owner.
- **Steps:** run preflight with the staging context's values (setup step 4),
  after step 7.
- **Expected:** 0 failed. Warnings only for items deliberately off (e.g.
  email), each explained in the record.
- **Evidence:** the preflight output (it contains no secrets).
- **Actual:** —
- **Status:** Blocked — missing access (R1–R10 not provisioned; 9 Oct 2026). Before launch, run it again with production's values: **0 failed** is a launch requirement.

### Setup log

| Date | Step | Result | By |
|---|---|---|---|
| 2026-10-09 | R1 staging database (Neon), R3 Clerk development instance, R4 Shopify development store with 3 placeholder "STAGING TEST" products, R5 Storefront token | Provisioned by the owner. Values held in a private env file outside the repository. | Owner |
| 2026-10-09 | Setup step 3: migration dry run → apply → verify (C1) | Empty database confirmed (no history, no marker); 0000–0005 applied; marked `staging`; nothing pending | Developer |
| 2026-10-09 | Setup step 4: preflight (C3), run locally with staging values | 15 passed, 3 warnings, 1 failed. Fail: `SHOPIFY_WEBHOOK_SECRET` (expected until the webhooks exist after the first deploy). Warnings: same secret; email not configured; `TRUSTED_PROXY_HOPS` (not applicable on Netlify). No Shopify price check yet: no products in the staging site. | Developer |
| — | Still open | `SITE_URL` must be the branch-deploy address; commit/push to a `staging` branch (needs authorisation); Netlify branch-deploy variables; role defaults (C2); webhooks (R6); staging products and variant ids (R7) | Owner / developer |

### Record summary

| Test | Status | Evidence link | Defects |
|---|---|---|---|
| S1 | Blocked: missing access (9 Oct 2026) | | |
| S2 | Blocked: missing access (9 Oct 2026) | | |
| S3 | Blocked: missing access (9 Oct 2026) | | |
| S4 | Blocked: missing access (9 Oct 2026) | | |
| S5 | Blocked: missing access (9 Oct 2026) | | |
| S6 | Blocked: missing access (9 Oct 2026) | | |
| S7 | Blocked: missing access (9 Oct 2026) | | |
| S8 | Blocked: missing access (9 Oct 2026) | | |
| S9 | Blocked: missing access (9 Oct 2026) | | |
| S10 | Blocked: missing access (9 Oct 2026) | | |
| S11 | Blocked: missing access (9 Oct 2026) | | |
| S12 | Blocked: missing access (9 Oct 2026) | | |
| S13 | Blocked: missing access (9 Oct 2026) | | |
| S14 | Blocked: missing access (9 Oct 2026) | | |
| S15 | Blocked: missing access (9 Oct 2026) | | |
| B1–B6 | Blocked: missing access (9 Oct 2026) | | |

## 7. Manual actions needed

| Action | Who |
|---|---|
| Provision R1–R10 and enter section 2's variables | Owner |
| Migrate and mark the staging database; run preflight | Owner or developer |
| Deploy the reviewed commit to the staging context | Owner |
| Create products/variants and webhooks in the development store | Owner |
| Run S1–S15 and B1–B6, attach evidence | Tester |
| S14 (touches a production-marked database's configuration) | Owner only |
| Witness S1, S2, S5–S8, S10, S11 and sign the acceptance checklist (`LAUNCH_READINESS.md` §8) | Client |
| Decide D1–D10 | Client |

## 8. Remaining blockers before launch

1. Resources R1–R10 do not exist yet.
2. S1–S15 and B1–B6 have not been run. In particular **S2/S3 (real Shopify
   payment and signature)**, **S13 (real proxy)** and **S14** must Pass.
3. Decisions D1–D10 open, including the delivery-rate and discount policy
   (D4) that determines whether real Shopify payments match.
4. Client acceptance (AC1–AC10) not signed.
5. Production: resources, migration with `--environment production`, and
   preflight with 0 failures. Not started; never part of staging work.
