# Refunds, incentive reversals and payouts

How money-related records behave since the financial-integrity change, how to
apply its migration, and how to reconcile data recorded before it.

## Rules

**Accruals are never resized.** An accrual is the incentive on an order line's
full quantity (5% Team Leader, 2% Manager, 1% Director of the wholesale value).
Month-end settlement confirms or voids it but never changes its amount.

**Each refund reverses each affected accrual once.** A refund, cancellation,
return or chargeback creates a `refunds` row (with `refund_items`) and, per
affected accrual, one negative `reversal` row linked by `refund_id`
(unique per refund + accrual). The reversal is the accrual's proportional share
for the refunded units, rounded to the cent and capped at what is still
unreversed. The refund that completes the line reverses exactly the remainder,
so a fully refunded line always nets to R0.00 and reversals never exceed the
original incentive.

Example: 3 bottles at R139.95 wholesale = R419.85, Team Leader 5% = R20.99.
Refund 1, refund 1, then the rest: −R7.00, −R7.00, −R6.99 → net R0.00.
Three equal shares of R7.00 would have reversed R21.00, more than was earned.

**Each source event applies once.** A refund carries a stable id: the Shopify
refund id (`refund:<id>`), the Shopify order id for cancellations
(`cancel:<id>`), or the admin form's idempotency key. A repeated, retried or
concurrent delivery finds the existing refund and changes nothing. The whole
refund (records, refunded quantities, stock, reversals, order status, audit
row) is one transaction with the order row locked; a failure leaves nothing
behind and can simply be retried.

**Reversals follow their accrual.**

| Accrual status | New reversal | Effect |
|---|---|---|
| pending | pending | Approved together with the accrual |
| approved | approved | Deducted from the payout that pays the accrual, or the next one |
| paid | approved ("Clawback") | Deducted from the reseller's next payout; a fraud flag is raised |

Reversals cannot be approved on their own before their accrual.

**Payouts are calculated separately from being paid, and nothing moves money.**

```
pending ──approve──▶ approved ──processing──▶ processing ──paid──▶ paid
   └───────────────┴─────────────────────┴─────fail──▶ failed
```

- *Calculate* (Admin → Incentives → "Calculate payouts for YYYY-MM"; the period
  must be closed by the month-end run) allocates each reseller's approved,
  unallocated incentives of that period and earlier to one `pending` payout. A
  net zero or negative balance (clawbacks) carries forward.
- The administrator approves it, pays it from the bank, then records
  *processing* (with the EFT batch reference) and *paid*. Marking paid checks
  the payout still equals its ledger rows before marking them paid.
- *Failed* (reason required) releases the payout's rows so the next
  calculation includes them again.
- The database allows one non-failed payout per reseller and period, and a
  ledger row belongs to at most one payout. Repeating a step is a no-op.
  Every step records who did it and when, and writes an audit row in the same
  transaction.

## Applying the migration

`lib/db/migrations/0001_financial_integrity.sql` is additive: new tables,
nullable columns, indexes and CHECK constraints. It drops nothing and changes no
amounts. Legacy payouts get `paid_at`/`paid_by` copied from `created_at`/`created_by`.

1. Back up the database.
2. Pre-flight. Each query must return 0, or the migration rolls back:

```sql
select count(*) from order_items where refunded_quantity < 0 or refunded_quantity > quantity;
select count(*) from commission_ledger where not ((entry_type = 'accrual' and amount >= 0) or (entry_type = 'reversal' and amount <= 0));
select count(*) from commission_ledger where status not in ('pending', 'approved', 'paid', 'reversed', 'void');
select count(*) from payouts where amount <= 0 or status not in ('pending', 'approved', 'processing', 'paid', 'failed');
```

3. Apply it with the migration runner — procedure, backups and rollback
   limitations in `DATABASE_MIGRATIONS.md`. (The Netlify build no longer
   pushes the schema.)

## Data recorded before this change

Before this change, settlement shrank a pending accrual to the post-refund
quantity *and* kept its reversal, so partial refunds were deducted twice.
Full refunds marked accruals `reversed` instead of writing reversal rows.
Such rows are left exactly as they are: nothing is rewritten automatically.
This read-only query lists accruals that need a manual decision:

```sql
select a.id, a.order_number, a.beneficiary_reseller_id, a.kind, a.status,
       a.quantity as accrual_qty, i.quantity as line_qty, i.refunded_quantity,
       a.amount,
       coalesce((select sum(r.amount) from commission_ledger r
                 where r.reversal_of_id = a.id and r.status <> 'void'), 0) as reversed
from commission_ledger a
join order_items i on i.id = a.order_item_id
where a.entry_type = 'accrual'
  and (a.quantity <> i.quantity                       -- resized by the old settlement
       or a.status = 'reversed'                       -- old full-refund marker
       or exists (select 1 from commission_ledger r   -- old-style reversal rows
                  where r.reversal_of_id = a.id and r.refund_id is null));
```

The intended production path is a fresh database, so this should return
nothing there. On the demo database it may return rows; discard that data
rather than carrying it into production.
