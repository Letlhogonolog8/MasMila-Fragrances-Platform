# Launch readiness

Assessment of the Mas'Mila platform after Phases 1–5 (all changes local and
uncommitted, 9 October 2026), with the staging plan, acceptance checklist and
launch runbook.

## Decision: **Blocked** for production launch

The code is in a releasable state. Everything that can be verified without
the real services is verified:

- 46 unit and 98 integration tests pass;
- every database is built from the reviewed migrations;
- the production frontend build and both Netlify functions build.

The launch is **blocked** because none of the following has happened yet:

1. **No staging validation has been done.** There is no staging deployment,
   staging database or staging credentials. Clerk sign-in, a real Shopify
   test purchase, real webhook signatures and payloads, and the real
   Netlify/Replit proxy behaviour have never been exercised. Every Shopify
   payment in the tests is a synthetic, self-signed payload.
2. **Business decisions are open:** EFT and Shopify reservation periods, and
   what happens to late EFT payments (below).
3. **Shopify prices and delivery rates have not been compared** with the
   storefront's. If they differ, every Shopify payment is quarantined.

It becomes **conditionally ready for a controlled launch** when:

- the staging plan below passes on a real staging deployment;
- `preflight` passes for production;
- the decisions are signed off.

"Conditionally" means EFT plus Shopify for a limited audience, with daily
review of Payment review and Scheduled runs for the first two weeks.

## 1. Working tree

48 modified and 59 new files across Phases 1–5 and the staging preparation.
Nothing committed or deployed.

| Phase | Scope |
|---|---|
| 1 | Production fails closed on unsafe auth config; Clerk accounts by verified email only; demo sign-in/data impossible in production |
| 2 | Refund records; exact, capped commission reversals; payout lifecycle (pending → approved → processing → paid / failed) with single allocation |
| 3 | Shopify payment verification (amount, currency, status, reference, test flag) with quarantine; sequence-based order numbers; idempotent checkout; version-controlled migrations and runner; no schema push in builds |
| 4 | Month-end lease, retry and alerting; scheduled-jobs function and CLI; EFT reservation expiry (off); client IP from trusted sources only; database timeouts; Payment review admin screen |
| 5 | Shared (multi-instance) rate limiting; environment marker and guard (previews cannot serve from the production database); fraud flags closed with their payment; Shopify checkout expiry (off); session timeouts for statements outside transactions; `preflight`; maintenance switch; reseller names kept on approval; acceptance rehearsal suite |

Defects found and fixed during Phase 5 verification:

- **Approval lost the applicant's name.** An applicant who had signed in
  before applying (the normal Clerk flow) became a nameless reseller in team
  lists, payouts and reports.
- **Deprecated connection pattern.** The way session timeouts were sent on
  each new database connection was deprecated in the database driver (and
  will break in pg 9). It now uses the driver's supported connection hook.
- **Outdated `netlify.toml` header.** It described one function and an
  incomplete variable list.
- **Line-ending-sensitive migration checksums.** This Windows working copy
  stores files with CRLF line endings (`core.autocrlf`), while Netlify and
  Linux checkouts use LF. A migration applied from one machine would have
  been rejected as "changed" from another. Checksums are now computed on
  LF-normalised text (verified: the same file in CRLF and LF form gives the
  same checksum), and `.gitattributes` keeps migrations and shell scripts LF.

## 2. Staging test plan and results

The staging setup, isolation controls and the **execution record for S1–S15**
(steps, expected outcome, required evidence, actual result, status) are in
[`STAGING.md`](STAGING.md). Every S-test is **Blocked — missing access**
(9 October 2026): resources R1–R10 have not been provisioned, and there is no
access to Netlify, Clerk, Shopify or a staging database. The staging commands
were rehearsed locally (command syntax only). Local test runs
(synthetic data, test-mode sign-in, self-signed payloads) never count as a
staging Pass.

| # | Verify | Local evidence | Staging |
|---|---|---|---|
| S1 | Clerk sign-in and roles | Role checks via test sign-in; production rejects demo tokens and forged roles | Blocked (missing access) |
| S2 | Purchase via Shopify test checkout | Synthetic signed payloads only | Blocked (missing access) |
| S3 | Genuine webhook signature and payload | Not possible locally | Blocked (missing access) |
| S4 | Duplicate delivery | Passed (synthetic) | Blocked (missing access) |
| S5 | Mismatch quarantine | Passed (synthetic) | Blocked (missing access) |
| S6 | Cancellation and refund from Shopify | Passed (synthetic) | Blocked (missing access) |
| S7 | Commission accrual and reversal | Passed (AC4/AC5) | Blocked (missing access) |
| S8 | Payouts, no real transfer | Passed (AC6) | Blocked (missing access) |
| S9 | Month-end scheduling, retry, alerts | Passed (lease, crash, timeout, retry) | Blocked (missing access) |
| S10 | Reservation expiry, races, stock | Passed (12-order race) | Blocked (missing access) |
| S11 | Payment review resolution | Passed | Blocked (missing access) |
| S12 | Timeouts / database unavailable | Passed | Blocked (missing access) |
| S13 | Client IP behind the real proxy | Passed (spoofing, two instances) | Blocked (missing access) |
| S14 | Preview cannot use the production database | Passed (built deploy-preview bundle → 503) | Blocked (missing access) |
| S15 | Preflight | Passed (rehearsal) | Blocked (missing access) |

Controls added while preparing staging:

- **Staging settles only Shopify test payments.** A live payment that
  reaches staging is quarantined as `live_payment_in_staging`; production
  still rejects test payments.
- **Webhooks are accepted only from the configured store**
  (`X-Shopify-Shop-Domain`), and each payment notification records the
  sending store, API version and test flag (migration 0005), so S2/S3
  evidence can be told apart from synthetic payloads.
- **Preflight checks credentials against the environment.** It fails on a
  live Clerk key on staging or a development key on production, and on a
  store domain that is not `<name>.myshopify.com`.
- **A read-only `staging-evidence` report** for the execution record.

## 3. Outstanding issues from Phase 4

| Issue | Resolution | Verified |
|---|---|---|
| Real Shopify webhook payload and signature | Code follows Shopify's documented HMAC (raw body, base64) and the 2026-10 order payload | **Unverified** against a real delivery: S3 |
| Shopify vs storefront totals (product, discount, shipping, currency) | `preflight` compares every variant price (ZA context) with the storefront price; currency checked per payment | Price check tested with a stubbed Storefront API. **Delivery rates and discount codes cannot be checked automatically**: any difference quarantines the payment (safe; manual work). Decision D4. |
| Abandoned Shopify checkout reservations | Optional expiry (`shopifyReservationHours`, off); a later payment is quarantined | Local ✓ (L10); decision D3 |
| Rate limiting across instances | Counters in the database, atomic per request, hashed keys | Local ✓ (two server processes share one allowance) |
| Netlify / Replit client IP | Netlify: `x-nf-client-connection-ip`; elsewhere: explicit `TRUSTED_PROXY_HOPS` (default 0) | **Unverified on both hosts.** Replit's proxy chain is undocumented; Netlify's header comes from Netlify staff on their forum. S13. |
| Fraud flag after resolution | Linked to the payment event and closed in the same audited transaction | Local ✓ (L9, AC7). Flags raised before migration 0004 are not linked. |
| Timeouts outside transactions | Session timeouts set on every new connection, plus `SET LOCAL` in transactions | Local ✓ (L4). Through Neon's transaction pooler a session setting may not reach every server connection; set role defaults (`OPERATIONS.md`). |

## 4. Remaining defects and risks

| Severity | Item |
|---|---|
| **High (launch blocker)** | Real Shopify payment flow never exercised end to end (S2/S3). Field names and signature handling are unverified against a real store. |
| **High (launch blocker)** | Shopify delivery rates and discounts not reconciled with the storefront. Mismatches quarantine payments and pile up manual work. |
| Medium | Client-IP source unverified on the real hosts. On Replit, without `TRUSTED_PROXY_HOPS`, every visitor shares one allowance (20 checkouts per 10 minutes in total). |
| Medium | Netlify scheduled functions stop after 30 s. A large month-end run resumes hourly; untested at real data volume. |
| Medium | Email delivery (Resend) untested; without it, customers get no order or expiry emails and administrators no alert emails. |
| Low | Rate-limit allowance (20 per 10 min per address) may be tight for shared networks such as offices or mobile carriers behind NAT. |
| Low | Fraud flags raised before migration 0004 must be closed by hand. |
| Low | The storefront bundle has a 545 kB main chunk (performance only). |
| Low (pre-existing) | Two Vite sourcemap warnings in UI library files (`tooltip.tsx`, `command.tsx`). |

## 5. Decisions and sign-offs needed from Mas'Mila

| # | Decision | Proposed |
|---|---|---|
| D1 | EFT reservation period | 120 hours (5 days) |
| D2 | EFT money received after expiry | Refund, or the administrator places a new order (current behaviour) |
| D3 | Unfinished Shopify checkout reservation period | 24 hours |
| D4 | Shopify delivery rates and discount codes | Shopify delivery rates mirror the storefront (R99 flat; free from R750); **no Shopify discount codes** at launch |
| D5 | Shopify store for staging | A separate Shopify development store (test gateway), never the live store. Staging settles only test payments regardless. |
| D6 | Month-end retry policy | 5 attempts, 15 min doubling to 6 h |
| D7 | Rate limit | 20 requests / 10 min per address on checkout, applications, enquiries, newsletter, tracking |
| D8 | Who are the administrators (`ADMIN_EMAILS`), with MFA enforced in Clerk | — |
| D9 | Placeholder brand photography and `noindex` removed before public launch | Required before public launch |
| D10 | Sign-off of the acceptance checklist (section 8) on staging | — |

## 6. Environment and migration checklist

Per environment: production and staging must use **different** values for
every item marked *.

- [ ] Netlify: `DATABASE_URL`* set per deploy context. Production context → production database; deploy previews and branch deploys → staging database.
- [ ] Clerk*: production instance (`sk_live_`/`pk_live_`) for production, a separate development instance for staging. `VITE_CLERK_PUBLISHABLE_KEY` equals `CLERK_PUBLISHABLE_KEY`.
- [ ] `ADMIN_EMAILS`, `SITE_URL`* set.
- [ ] Shopify: `SHOPIFY_STORE_DOMAIN`*, `SHOPIFY_STOREFRONT_TOKEN`*, `SHOPIFY_WEBHOOK_SECRET`* (a development store for staging).
- [ ] `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` set.
- [ ] Not set anywhere deployed: `DEMO_AUTH`, `SEED_DEMO_DATA`, `MAINTENANCE_MODE` (except during maintenance). `SHOPIFY_ALLOW_TEST_ORDERS` only in the staging context.
- [ ] Replit only: `DEPLOY_ENVIRONMENT`, and `TRUSTED_PROXY_HOPS` after verifying with the diagnostic.
- [ ] Database role defaults set (statement 15 s, lock 10 s).
- [ ] **Migrations** (never run by a build, hook or app start). For each environment:
  1. Back up.
  2. Run the pre-flight queries.
  3. Dry run with `--environment`.
  4. Apply with `--apply --environment`.
  5. Confirm the dry run now shows nothing pending.

  Staging first. Production only after staging passes, and never as part of this assessment.
- [ ] Existing databases created by `push`: `--baseline` up to what they contain (`DATABASE_MIGRATIONS.md`).
- [ ] `pnpm --filter @workspace/api-server run preflight` passes for staging, then for production.
- [ ] Verified automatically: the Netlify build command, `scripts/post-merge.sh` and `.replit` contain no schema push, and `drizzle-kit` refuses inside Netlify builds and Replit deployments (`edge-safety.test.ts`). The devcontainer runs `push-force` against its own local database only.

## 7. Backup, rollback, monitoring and incident response

**Before each deployment**

- Neon: create a branch (or note the restore point time).
- Record the deploy id and the migration state (dry run output).

**Rollback: code first.**

- Migrations 0001–0004 are additive, so the previous code runs on the
  migrated database.
- On Netlify, "Publish deploy" on the previous production deploy. On Replit,
  redeploy the previous commit.
- No data is lost.

**Rollback: data, only for data corruption.**

1. Set `MAINTENANCE_MODE=true`. Every API request and webhook gets 503 and
   nothing is written. Shopify retries failed webhooks for a limited time,
   so keep maintenance short. Confirm Shopify's current retry window in its
   webhook documentation. Afterwards, compare paid Shopify orders with Payment
   review for anything not redelivered.
2. Export everything written since the restore point:
   ```sql
   select * from orders where created_at > :t or updated_at > :t;
   select * from refunds where created_at > :t;
   select * from payment_events where created_at > :t;
   select * from commission_ledger where updated_at > :t;
   select * from payouts where updated_at > :t;
   select * from audit_logs where created_at > :t;
   ```
3. Restore the branch or the point in time.
4. Re-apply what must survive. Orders and payments: from the export,
   cross-checked against Shopify and the bank. Payouts: from the export and
   the bank batch. Never re-pay a payout that is already paid at the bank.
5. Run `preflight`, then lift maintenance mode. Webhooks Shopify retried
   during maintenance are then processed normally (duplicates are recognised).

**Monitoring** (log `event` fields, see `OPERATIONS.md`): alert on

- `payment.rejected`
- `webhook.signature_invalid` (spikes)
- `webhook.processing_failed`
- `job.failed`
- `expiry.failed`
- `db.unavailable`
- `config.database_environment`
- `config.proxy_untrusted`
- any `fatal`

Daily for the first two weeks: Payment review (awaiting review), Scheduled
runs, Fraud & abuse.

**Incident response**

| Situation | First action |
|---|---|
| Payments being quarantined in bulk | Check price, delivery or discount drift (`preflight`); fix in Shopify; resolve each event after refund or manual confirmation |
| Suspected wrong payouts | Do not mark further payouts paid; reconcile `payouts` against `commission_ledger` (`FINANCIAL_INTEGRITY.md`) |
| Month-end failed | Read the error in Scheduled runs; fix; "Run qualification" (safe to re-run) |
| Database errors / 503s | Check `db.unavailable` logs and Neon status; requests recover automatically |
| Data corruption | Maintenance mode, then data rollback (above) |
| Credential leak | Rotate the key in Clerk, Shopify or Neon; update the environment; redeploy |

## 8. Client acceptance checklist

Local evidence: `acceptance.integration.test.ts`, which runs the whole story
over HTTP, plus the suite named in each row. **Every item still needs the
staging run (D10)** before client sign-off.

| # | Test case | Local | Staging | Client approval |
|---|---|---|---|---|
| AC1 | Customer registers, buys (EFT), is confirmed by an administrator, tracks the order (needs number + email) | Passed | Blocked (Clerk sign-up) | Yes |
| AC1b | Customer buys through Shopify checkout | Passed (synthetic payment) | Blocked (S2/S3) | Yes |
| AC2 | Reseller application → administrator approval → placed under the referring Team Leader; only administrators decide | Passed | Blocked | Yes |
| AC3 | Wholesale price shown only to resellers; opening order minimum (10) enforced; customers cannot order at wholesale | Passed | Blocked | Yes (minimums are settings) |
| AC4 | Team hierarchy visible to the Team Leader; month-end qualification runs and records every reseller | Passed | Blocked | Yes (qualification rules) |
| AC5 | Commission: TL 5% × R1,400 = R70; return of 2 of 10 bottles → R56 | Passed | Blocked | Yes |
| AC6 | Payout calculated once (double submit), approved → processing → paid, no step skipped, reconciles with ledger; resellers cannot approve | Passed | Blocked | Yes (payout process) |
| AC7 | Payment exception quarantined; investigated and resolved with a reason; order not marked paid; fraud flag closed; audited | Passed | Blocked | Yes |
| AC8 | Stock reserved at checkout, released on cancellation; expiry and payment race (`operations` E2/E3) | Passed | Blocked (D1, D3) | Yes |
| AC9 | Reports (CSV), audit trail, masked customer data for resellers, customers see only their orders, every admin area refused to non-admins | Passed | Blocked | Yes (privacy) |
| AC10 | Production refuses demo sign-in, demo data and forged roles (`startup` suite) | Passed | Blocked | No (technical) |

No item failed. None is "not applicable".
