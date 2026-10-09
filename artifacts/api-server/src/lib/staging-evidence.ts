import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * Read-only evidence report for the staging test record (docs/STAGING.md):
 * the state the S1–S15 checks are judged on, as Markdown tables to paste into
 * the record. No customer names, emails, phone numbers, addresses or secrets
 * are printed — orders appear by number, resellers by code.
 */

type Row = Record<string, unknown>;

const cell = (v: unknown) => (v == null ? "—" : v instanceof Date ? v.toISOString().replace("T", " ").slice(0, 19) : String(v).replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 80));

export function table(title: string, rows: Row[], columns: string[]): string {
  if (!rows.length) return `### ${title}\n\n_none_\n`;
  const head = `| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|`;
  return `### ${title}\n\n${head}\n${rows.map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`).join("\n")}\n`;
}

const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Row[];

/**
 * A payment notification counts as provider evidence only if it carries the
 * sending store, the webhook API version and Shopify's delivery id (recorded
 * from Shopify's headers after the signature and store were verified). A
 * hand-made payload signed with the secret lacks real Shopify order and
 * delivery ids that can be found in the store's admin — so the record must
 * also cross-check the Shopify order in the store.
 */
export const provenance = (e: Row) => (e.shop_domain && e.api_version && e.delivery_id ? `shopify:${e.shop_domain}` : "unverified");

export async function stagingEvidence(opts: { limit?: number; order?: string | null } = {}): Promise<string> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const out: string[] = [`## Staging evidence — ${new Date().toISOString()}`, ""];

  const marker = await rows(sql`select environment, marked_at, marked_by from deployment_marker`).catch(() => []);
  const migrations = await rows(sql`select name, applied_at from schema_migrations order by name`).catch(() => []);
  out.push(table("Database", marker, ["environment", "marked_at", "marked_by"]));
  out.push(table("Migrations applied", migrations, ["name", "applied_at"]));

  const events = await rows(sql`
    select e.id, e.created_at, e.topic, e.outcome, e.reason, e.shop_domain, e.api_version, e.test_payment, e.delivery_id,
           e.external_reference as shopify_order, e.external_order_id as shopify_order_id, e.amount, e.currency, e.financial_status,
           o.order_number, o.status as order_status, o.total as order_total,
           case when e.resolved_at is not null then e.resolution_action when e.outcome = 'rejected' then 'awaiting review' end as review
    from payment_events e left join orders o on o.id = e.order_id
    order by e.id desc limit ${limit}`);
  out.push(table("Payment notifications (newest first)", events.map((e) => ({ ...e, provenance: provenance(e) })), [
    "id", "created_at", "topic", "outcome", "reason", "provenance", "api_version", "test_payment", "delivery_id", "shopify_order", "shopify_order_id", "amount", "currency", "financial_status", "order_number", "order_total", "order_status", "review",
  ]));

  const refunds = await rows(sql`
    select r.id, r.created_at, o.order_number, r.type, r.source, r.external_id, r.amount, r.order_was_paid, r.actor
    from refunds r join orders o on o.id = r.order_id order by r.id desc limit ${limit}`);
  out.push(table("Refunds and cancellations", refunds, ["id", "created_at", "order_number", "type", "source", "external_id", "amount", "order_was_paid", "actor"]));

  if (opts.order) {
    const ledger = await rows(sql`
      select l.id, l.entry_type, l.kind, b.reseller_code as beneficiary, l.quantity, l.base_value, l.rate, l.amount, l.status, l.qualification_status, l.refund_id, l.reversal_of_id, l.payout_id
      from commission_ledger l join resellers b on b.id = l.beneficiary_reseller_id
      where l.order_number = ${opts.order} order by l.id`);
    out.push(table(`Incentive ledger for ${opts.order}`, ledger, ["id", "entry_type", "kind", "beneficiary", "quantity", "base_value", "rate", "amount", "status", "qualification_status", "refund_id", "reversal_of_id", "payout_id"]));
    const stock = await rows(sql`
      select p.sku, i.quantity, i.refunded_quantity, p.stock_quantity, p.reserved_quantity
      from order_items i join orders o on o.id = i.order_id join products p on p.id = i.product_id where o.order_number = ${opts.order}`);
    out.push(table(`Stock for ${opts.order}`, stock, ["sku", "quantity", "refunded_quantity", "stock_quantity", "reserved_quantity"]));
  }

  const payouts = await rows(sql`
    select p.payout_number, r.reseller_code, p.period, p.amount, p.entry_count, p.status, p.reference, p.created_at, p.approved_at, p.paid_at,
           (select coalesce(sum(amount), 0) from commission_ledger l where l.payout_id = p.id) as ledger_total
    from payouts p join resellers r on r.id = p.reseller_id order by p.id desc limit ${limit}`);
  out.push(table("Payouts (amount must equal ledger_total)", payouts, ["payout_number", "reseller_code", "period", "amount", "ledger_total", "entry_count", "status", "reference", "created_at", "approved_at", "paid_at"]));

  const months = await rows(sql`select period, status, attempts, last_error, started_at, finished_at from period_runs order by period desc limit 12`);
  out.push(table("Month-end runs", months, ["period", "status", "attempts", "last_error", "started_at", "finished_at"]));
  const jobs = await rows(sql`select id, job, period, trigger, attempt, status, started_at, finished_at, error from job_runs order by id desc limit ${limit}`);
  out.push(table("Job executions", jobs, ["id", "job", "period", "trigger", "attempt", "status", "started_at", "finished_at", "error"]));

  const queues = await rows(sql`
    select (select count(*) from payment_events where outcome = 'rejected' and resolved_at is null) as payments_awaiting_review,
           (select count(*) from fraud_flags where status = 'open') as open_fraud_flags,
           (select count(*) from orders where status = 'awaiting_payment') as unpaid_orders,
           (select count(*) from rate_limits) as rate_limit_buckets`);
  out.push(table("Queues", queues, ["payments_awaiting_review", "open_fraud_flags", "unpaid_orders", "rate_limit_buckets"]));

  const audit = await rows(sql`select id, created_at, action, entity_type, entity_id, actor_id from audit_logs order by id desc limit ${limit}`);
  out.push(table("Audit log (newest first)", audit, ["id", "created_at", "action", "entity_type", "entity_id", "actor_id"]));
  return out.join("\n");
}
