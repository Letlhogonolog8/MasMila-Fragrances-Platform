-- Phase 3 — payment integrity and checkout reliability.
--
-- Additive only: one sequence, one nullable column with a partial unique
-- index, one new table. No existing row, column or amount is changed. Apply
-- with the migration runner (docs/DATABASE_MIGRATIONS.md), which runs this
-- file in a single transaction after 0001_financial_integrity.sql.

-- Order numbers come from a sequence (MM-YYMMDD-00042) instead of 4 random
-- digits retried inside an aborted transaction. Existing order numbers (4
-- digit suffix) can never equal a new one (5+ digit suffix).
CREATE SEQUENCE "public"."order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;

-- Checkout idempotency key: a retried checkout returns the order it created.
ALTER TABLE "orders" ADD COLUMN "checkout_key" text;
CREATE UNIQUE INDEX "orders_checkout_key_uq" ON "orders" USING btree ("checkout_key") WHERE checkout_key is not null;

-- Every payment notification, applied or rejected (quarantined), once per payment.
CREATE TABLE "payment_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"topic" text NOT NULL,
	"event_key" text NOT NULL,
	"delivery_id" text,
	"order_id" integer,
	"external_order_id" text,
	"external_reference" text,
	"amount" numeric(12, 2),
	"currency" text,
	"financial_status" text,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_outcome_valid" CHECK ("payment_events"."outcome" in ('applied', 'already_applied', 'rejected'))
);
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "payment_events_provider_key_uq" ON "payment_events" USING btree ("provider","event_key");
CREATE INDEX "payment_events_order_idx" ON "payment_events" USING btree ("order_id");
