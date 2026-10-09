-- Phase 5 — launch safety.
--
-- Additive only: two new tables, two nullable columns, CHECK constraints that
-- every existing row satisfies. No row is changed. Apply with the migration
-- runner (docs/DATABASE_MIGRATIONS.md); mark the database's environment in the
-- same run with `--environment production|staging|development`.

-- Shared rate-limit counters (all instances count against one allowance).
CREATE TABLE "rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);

-- The environment this database belongs to; deployments for another environment refuse to use it.
CREATE TABLE "deployment_marker" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"environment" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"marked_by" text,
	CONSTRAINT "deployment_marker_single_row" CHECK ("deployment_marker"."id" = 1),
	CONSTRAINT "deployment_marker_environment_valid" CHECK ("deployment_marker"."environment" in ('production', 'staging', 'development'))
);

-- A fraud flag raised for a quarantined payment is closed when that payment is resolved.
ALTER TABLE "fraud_flags" ADD COLUMN "payment_event_id" integer;
ALTER TABLE "fraud_flags" ADD CONSTRAINT "fraud_flags_payment_event_id_payment_events_id_fk" FOREIGN KEY ("payment_event_id") REFERENCES "public"."payment_events"("id") ON DELETE no action ON UPDATE no action;

-- Optional expiry of unpaid Shopify checkouts (abandoned carts). NULL = never (current behaviour).
ALTER TABLE "compensation_settings" ADD COLUMN "shopify_reservation_hours" integer;
ALTER TABLE "compensation_settings" ADD CONSTRAINT "settings_shopify_reservation_hours_positive" CHECK ("compensation_settings"."shopify_reservation_hours" is null or "compensation_settings"."shopify_reservation_hours" > 0);
