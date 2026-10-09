# Payments, checkout and webhooks

How an order becomes paid, what the Shopify webhook accepts, and what an
administrator does when a payment is refused.

## What can mark an order paid

| Path | Who | Checks |
|---|---|---|
| Shopify `orders/paid` webhook | Shopify | Signature, reference, amount, currency, status — below |
| Admin → order → status "paid" | An administrator | None automatic: the admin confirms an EFT (or a quarantined Shopify payment) after checking the bank or Shopify. Audited with the admin's id. |

Nothing else can. The browser redirect back from Shopify and any
client-supplied payment status are ignored. Commission is accrued only inside
the transaction that marks an order paid, so a refused or incomplete payment
never creates incentives, and therefore never reaches a payout.

## Shopify `orders/paid`

Endpoint `POST /api/webhooks/shopify`, configured in Shopify with
`SHOPIFY_WEBHOOK_SECRET` (the signing secret shown in Settings →
Notifications → Webhooks, or the app's client secret for an app
subscription).

0. **Store.** When `SHOPIFY_STORE_DOMAIN` is set, the delivery's
   `X-Shopify-Shop-Domain` must be that store; any other store (or none) gets
   `401` and nothing is stored. The store, `X-Shopify-API-Version` and the
   payload's `test` flag are recorded with each payment notification.
1. **Signature.** HMAC-SHA256 of the raw request body with the secret,
   base64, compared in constant time with `X-Shopify-Hmac-Sha256`. A missing
   or wrong signature → `401` and nothing is read or stored. If the secret is
   not set, every webhook is refused (and production logs a warning at start).
2. **Record.** One `payment_events` row per Shopify order
   (`orders/paid:<Shopify order id>`, unique). A retry or a concurrent
   delivery of the same payment finds the row and changes nothing
   (`outcome: "duplicate"`).
3. **Order.** Found by the `masmila_order` cart attribute (set when the
   checkout is created), else by the Shopify order id already linked to it.
   Locked for the rest of the transaction.
4. **Checks** (`assessShopifyPayment` in `lib/payments.ts`). Applied only if all hold:

| Check | Refused as |
|---|---|
| The order exists | `unknown_order` |
| `masmila_order` names this order; no other Shopify order is linked to it | `reference_mismatch` |
| The order is awaiting payment (same Shopify order again → `already_applied`, no change) | `duplicate_payment`, `order_refunded`, `order_cancelled` |
| It was placed as a Shopify checkout (not EFT) | `payment_method_mismatch` |
| Production deployment: `test` is not true | `test_payment` |
| Staging deployment: `test` **is** true — staging settles only test payments, never real money | `live_payment_in_staging` |
| `cancelled_at` is empty | `shopify_order_cancelled` |
| `financial_status` is `paid` | `partial_payment` (`partially_paid`), `not_paid` (anything else) |
| `total_price_set.shop_money.currency_code` (else `currency`) is `ZAR` | `currency_mismatch` |
| `total_outstanding` is 0 | `partial_payment` |
| `total_price_set.shop_money.amount` (else `total_price`) equals the order total **to the cent** | `underpayment`, `overpayment` |

5. **Apply** — in the same transaction: order `paid` (linked to the Shopify
   order id, reference = Shopify order name), stock deducted and reservation
   released, reseller activation, incentives accrued, audit row
   (`order_paid`, with the payment event id). If anything fails, everything
   rolls back, including the event row, and the webhook returns `500` so
   Shopify retries from scratch.
6. **Refuse** — the event is kept with `outcome = 'rejected'` and the reason
   (quarantine); the order, stock and ledger are untouched; a high-severity
   `payment_rejected` flag is raised (admin notification, Admin → Fraud).

The webhook answers `200` for every decision (applied, duplicate, refused) so
Shopify does not retry a decision, `401` for a bad signature, and `500` only
when processing failed.

Field names follow Shopify's REST Order webhook payload (checked against the
2026-10 webhook reference sample). **Not yet verified against a real
delivery from the store** — see "Before go-live".

### Policy for unusual payments

| Situation | What happens | What the administrator does |
|---|---|---|
| Underpaid / partially paid | Quarantined, order stays awaiting payment | Collect the difference or refund in Shopify; mark paid manually once the full amount is in |
| Overpaid | Quarantined (never silently accepted) | Refund the difference in Shopify, then mark paid manually |
| Paid twice (second Shopify order for a paid order) | Second one quarantined as `duplicate_payment` | Refund the second Shopify order |
| Paid after the order was cancelled or refunded | Quarantined | Refund in Shopify (or re-open by placing a new order) |
| Wrong currency | Quarantined | Check the Shopify store currency; refund |
| Shopify test order | Quarantined | Nothing (test) |

**Prices must match.** Shopify charges its own product prices and delivery
rates. The amount check only passes when the Shopify price of each variant
and the Shopify delivery charge equal the storefront's prices and the
shipping settings (`shippingFor`). If they drift, every Shopify payment is
quarantined (safe, but each needs manual confirmation). Discount codes
entered in Shopify have the same effect.

## Shopify refunds and cancellations

`refunds/create` and `orders/cancelled` (see `FINANCIAL_INTEGRITY.md` for
what a refund does). They act only on the order linked to that Shopify order
by a verified payment. An order not linked to a Shopify payment accepts only
the cancellation of its still-unpaid Shopify checkout (which releases the
reserved stock); anything else — e.g. a Shopify cancellation naming an EFT
order — is refused, flagged (`webhook_rejected`) and acknowledged with `200`.

## Checkout

- **Order numbers** are `MM-YYMMDD-NNNNN`, the suffix taken from the Postgres
  sequence `order_number_seq`, so two checkouts can never get the same
  number. (Before: 4 random digits per day, retried after a unique-key error
  *inside the same transaction*, which Postgres had already aborted — the
  retry failed and the customer got a 500.) Gaps in the sequence are normal
  (a rolled-back checkout uses up its number).
- **One transaction** creates the order, its lines and the stock reservations;
  a sold-out line rolls all of it back (`409`). Reservations use a guarded
  update (`stock − reserved ≥ quantity`), so simultaneous checkouts cannot
  oversell.
- **Idempotent retries.** The storefront sends an `idempotencyKey` (a random
  UUID per checkout attempt, renewed when the bag changes). A retried,
  double-clicked or concurrent request with the same key returns the order
  the first created (`200`) — no second order, reservation or Shopify cart, so
  the customer is only ever sent to one Shopify checkout. A key used from a
  different account is refused (`409`). A failed checkout does not consume its
  key.
- **Shopify checkout creation** happens after the order is saved. If Shopify
  is unavailable the order falls back to EFT. If a retry arrives while the
  first request is still creating the Shopify checkout it is asked to try
  again (`409`); after 60 s without a checkout URL the order falls back to EFT.

## Logs and alerts

Structured `event` field on every log line, without customer names, emails,
phone numbers, addresses, secrets or signatures (checked):

| `event` | Level | Meaning |
|---|---|---|
| `webhook.signature_invalid` | warn | Webhook with a bad/missing signature (401) |
| `webhook.secret_missing` | error | `SHOPIFY_WEBHOOK_SECRET` not set |
| `webhook.processing_failed` | error | Exception while processing; rolled back; Shopify will retry |
| `webhook.invalid_json`, `webhook.unknown_order`, `webhook.ignored_topic` | error / warn / info | Signed but unusable event |
| `payment.applied` / `payment.already_applied` / `payment.duplicate_delivery` | info | Outcome of `orders/paid` |
| `payment.rejected` | warn | Quarantined, with `reason`, expected and received amount/currency |
| `webhook.refund_rejected`, `refund.applied`, `refund.duplicate_delivery`, `refund.no_change` | warn / info | Shopify refund/cancel outcomes |
| `checkout.failed` / `checkout.refused` | error / info | Checkout 5xx / 4xx (mode, line count, status, reason) |
| `checkout.replayed`, `checkout.key_conflict`, `checkout.shopify_failed` | info / warn / error | Idempotent retry, key misuse, Shopify unavailable |

Alerts: `payment_rejected` and `webhook_rejected` raise high-severity fraud
flags, which notify administrators in the app and by email to
`ADMIN_EMAILS` (when email delivery, `RESEND_API_KEY`, is configured). Set up log-based alerts in the hosting platform on
`payment.rejected`, `webhook.processing_failed`, `webhook.signature_invalid`
spikes, `webhook.secret_missing` and `checkout.failed`.

Quarantined payments are reviewed and resolved in Admin → **Payment review**
(filters, investigation, an audited resolution that never moves money). See
`OPERATIONS.md` → "Payment review".

## Before go-live

1. In Shopify, subscribe `orders/paid`, `orders/cancelled` and
   `refunds/create` to `https://<site>/api/webhooks/shopify`; set
   `SHOPIFY_WEBHOOK_SECRET`.
2. On **staging**, place a real low-value Shopify order end to end and confirm
   the event is `applied`. This is the only check of the real payload; the
   automated tests use synthetic payloads.
3. Confirm Shopify variant prices and delivery rates equal the storefront's.
4. Leave `SHOPIFY_ALLOW_TEST_ORDERS` unset in production (it is ignored there
   anyway).
