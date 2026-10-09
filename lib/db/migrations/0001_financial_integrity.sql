-- Phase 2 — financial integrity (refund records, ledger refund links, payout lifecycle).
--
-- Additive only: no table, column or row is dropped, and no existing amount is
-- changed. Apply with the migration runner after taking a backup (see
-- docs/DATABASE_MIGRATIONS.md); it runs this file once, in one transaction,
-- after 0000_baseline.sql. Equivalent manual command:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f lib/db/migrations/0001_financial_integrity.sql
--
-- If existing data violates a new CHECK constraint the whole migration rolls
-- back and nothing changes; see docs/FINANCIAL_INTEGRITY.md for the
-- pre-flight queries. Afterwards `drizzle-kit push` reports no differences
-- against lib/db/src/schema/masmila.ts.

-- Refunds: one row per refund/cancellation/return/chargeback, unique per source event.
CREATE TABLE "refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"reason" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"order_was_paid" boolean NOT NULL,
	"initiated_by" integer,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "refunds_source_external_uq" ON "refunds" USING btree ("source","external_id") WHERE external_id is not null;
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");

CREATE TABLE "refund_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"refund_id" integer NOT NULL,
	"order_item_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"restocked_quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "refund_items_quantity_positive" CHECK ("refund_items"."quantity" > 0)
);
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "refund_items_refund_item_uq" ON "refund_items" USING btree ("refund_id","order_item_id");
CREATE INDEX "refund_items_order_item_idx" ON "refund_items" USING btree ("order_item_id");

-- Order lines: refunded quantity can never exceed the quantity sold.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_refunded_quantity_range" CHECK ("order_items"."refunded_quantity" >= 0 and "order_items"."refunded_quantity" <= "order_items"."quantity");

-- Commission ledger: reversals link to their refund; one reversal per refund and accrual.
ALTER TABLE "commission_ledger" ADD COLUMN "refund_id" integer;
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "ledger_refund_reversal_uq" ON "commission_ledger" USING btree ("refund_id","reversal_of_id") WHERE refund_id is not null;
CREATE INDEX "ledger_order_idx" ON "commission_ledger" USING btree ("order_id");
CREATE INDEX "ledger_reversal_of_idx" ON "commission_ledger" USING btree ("reversal_of_id");
CREATE INDEX "ledger_payout_idx" ON "commission_ledger" USING btree ("payout_id");
ALTER TABLE "commission_ledger" ADD CONSTRAINT "ledger_amount_sign" CHECK (("commission_ledger"."entry_type" = 'accrual' and "commission_ledger"."amount" >= 0) or ("commission_ledger"."entry_type" = 'reversal' and "commission_ledger"."amount" <= 0));
ALTER TABLE "commission_ledger" ADD CONSTRAINT "ledger_status_valid" CHECK ("commission_ledger"."status" in ('pending', 'approved', 'paid', 'reversed', 'void'));

-- Payouts: lifecycle pending → approved → processing → paid | failed, one live payout per reseller and period.
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'pending';
ALTER TABLE "payouts" ADD COLUMN "period" text;
ALTER TABLE "payouts" ADD COLUMN "approved_by" integer;
ALTER TABLE "payouts" ADD COLUMN "approved_at" timestamp with time zone;
ALTER TABLE "payouts" ADD COLUMN "processing_by" integer;
ALTER TABLE "payouts" ADD COLUMN "processing_at" timestamp with time zone;
ALTER TABLE "payouts" ADD COLUMN "paid_by" integer;
ALTER TABLE "payouts" ADD COLUMN "paid_at" timestamp with time zone;
ALTER TABLE "payouts" ADD COLUMN "failed_by" integer;
ALTER TABLE "payouts" ADD COLUMN "failed_at" timestamp with time zone;
ALTER TABLE "payouts" ADD COLUMN "failure_reason" text;
ALTER TABLE "payouts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_processing_by_users_id_fk" FOREIGN KEY ("processing_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_failed_by_users_id_fk" FOREIGN KEY ("failed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "payouts_reseller_period_uq" ON "payouts" USING btree ("reseller_id","period") WHERE period is not null and status <> 'failed';
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive" CHECK ("payouts"."amount" > 0);
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_valid" CHECK ("payouts"."status" in ('pending', 'approved', 'processing', 'paid', 'failed'));

-- Legacy payouts were recorded as paid at creation by their creator: say so in the new columns.
UPDATE "payouts" SET "paid_at" = "created_at", "paid_by" = "created_by", "updated_at" = "created_at" WHERE "status" = 'paid' AND "paid_at" IS NULL;
