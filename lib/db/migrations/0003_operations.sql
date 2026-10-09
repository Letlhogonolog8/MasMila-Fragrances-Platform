-- Phase 4 — operational reliability and payment operations.
--
-- Additive only: new nullable columns, columns with defaults, one new table,
-- CHECK constraints that every existing row satisfies. No row is changed.
-- Apply with the migration runner (docs/DATABASE_MIGRATIONS.md).

-- Month-end run lease and retry state (lib/jobs.ts). A legacy row stuck in
-- 'running' has no lease and is therefore reclaimable by the next run.
ALTER TABLE "period_runs" ADD COLUMN "lease_owner" text;
ALTER TABLE "period_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;
ALTER TABLE "period_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "period_runs" ADD COLUMN "last_error" text;
ALTER TABLE "period_runs" ADD COLUMN "started_at" timestamp with time zone;
ALTER TABLE "period_runs" ADD COLUMN "finished_at" timestamp with time zone;

-- Execution history of scheduled and administrator-started jobs.
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"period" text,
	"trigger" text NOT NULL,
	"actor_id" integer,
	"owner" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"result" text,
	CONSTRAINT "job_runs_status_valid" CHECK ("job_runs"."status" in ('running', 'succeeded', 'failed', 'abandoned'))
);
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");

-- Unpaid EFT reservation expiry. NULL (the default) = never expire, i.e. the
-- current behaviour, until the business approves a duration.
ALTER TABLE "compensation_settings" ADD COLUMN "eft_reservation_hours" integer;
ALTER TABLE "compensation_settings" ADD CONSTRAINT "settings_eft_reservation_hours_positive" CHECK ("compensation_settings"."eft_reservation_hours" is null or "compensation_settings"."eft_reservation_hours" > 0);

-- Administrator resolution of quarantined (rejected) payments.
ALTER TABLE "payment_events" ADD COLUMN "resolved_at" timestamp with time zone;
ALTER TABLE "payment_events" ADD COLUMN "resolved_by" integer;
ALTER TABLE "payment_events" ADD COLUMN "resolution_action" text;
ALTER TABLE "payment_events" ADD COLUMN "resolution_reason" text;
ALTER TABLE "payment_events" ADD COLUMN "resolution_order_status" text;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_resolution_valid" CHECK (("payment_events"."resolved_at" is null and "payment_events"."resolved_by" is null and "payment_events"."resolution_action" is null and "payment_events"."resolution_reason" is null)
        or ("payment_events"."outcome" = 'rejected' and "payment_events"."resolved_at" is not null and "payment_events"."resolved_by" is not null
            and "payment_events"."resolution_action" in ('refunded_in_shopify', 'confirmed_order_paid', 'no_action_required', 'other')
            and length(trim("payment_events"."resolution_reason")) >= 5));
