-- Baseline — the schema as first deployed (commit f7a6946, before Phase 2).
--
-- Generated with `drizzle-kit export` from that commit's
-- lib/db/src/schema/masmila.ts. Applies only to an EMPTY database. A database
-- that was created earlier with `drizzle-kit push` already has this schema:
-- record it as applied instead of running it (see docs/DATABASE_MIGRATIONS.md,
-- "Existing databases"). Never edit this file; schema changes go in a new,
-- higher-numbered migration.

CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "commission_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_type" text DEFAULT 'accrual' NOT NULL,
	"order_id" integer NOT NULL,
	"order_item_id" integer NOT NULL,
	"order_number" text NOT NULL,
	"period" text NOT NULL,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"seller_reseller_id" integer NOT NULL,
	"beneficiary_reseller_id" integer NOT NULL,
	"kind" text NOT NULL,
	"beneficiary_rank" text NOT NULL,
	"rate" numeric(6, 3) NOT NULL,
	"base_value" numeric(12, 2) NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"qualification_status" text DEFAULT 'provisional' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reversal_of_id" integer,
	"payout_id" integer,
	"note" text,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "compensation_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"opening_order" integer DEFAULT 10 NOT NULL,
	"reorder_minimum" integer DEFAULT 1 NOT NULL,
	"team_leader_rate" numeric(5, 2) DEFAULT 5 NOT NULL,
	"manager_rate" numeric(5, 2) DEFAULT 2 NOT NULL,
	"director_rate" numeric(5, 2) DEFAULT 1 NOT NULL,
	"director_enabled" boolean DEFAULT false NOT NULL,
	"referral_rate" numeric(5, 2) DEFAULT 0 NOT NULL,
	"count_attributed_retail" boolean DEFAULT true NOT NULL,
	"personal_target" integer DEFAULT 20 NOT NULL,
	"team_target" integer DEFAULT 100 NOT NULL,
	"tl_active_directs" integer DEFAULT 5 NOT NULL,
	"mgr_active_team_leaders" integer DEFAULT 3 NOT NULL,
	"mgr_active_resellers" integer DEFAULT 15 NOT NULL,
	"mgr_org_bottles" integer DEFAULT 300 NOT NULL,
	"mgr_personal_bottles" integer DEFAULT 20 NOT NULL,
	"dir_active_managers" integer DEFAULT 5 NOT NULL,
	"dir_active_resellers" integer DEFAULT 50 NOT NULL,
	"dir_org_bottles" integer DEFAULT 1000 NOT NULL,
	"active_min_bottles" integer DEFAULT 1 NOT NULL,
	"reactivation_bottles" integer DEFAULT 10 NOT NULL,
	"rank_grace_months" integer DEFAULT 1 NOT NULL,
	"large_order_bottles" integer DEFAULT 50 NOT NULL,
	"shipping_flat_rate" numeric(12, 2) DEFAULT 99 NOT NULL,
	"free_shipping_threshold" numeric(12, 2) DEFAULT 750 NOT NULL,
	"monthly_contribution_target" numeric(12, 2) DEFAULT 150000 NOT NULL,
	"bulk_discount_tiers" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "enquiries" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"company_name" text,
	"contact_person" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"quantity" integer,
	"product_preference" text,
	"required_date" text,
	"delivery_location" text,
	"branding_requirements" text,
	"message" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "fraud_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"reseller_id" integer,
	"order_id" integer,
	"user_id" integer,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);

CREATE TABLE "marketing_materials" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"min_rank" text DEFAULT 'reseller' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "newsletter_subscribers" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"contact" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_subscribers_contact_unique" UNIQUE("contact")
);

CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"audience" text DEFAULT 'user' NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"size" text NOT NULL,
	"quantity" integer NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	"unit_wholesale" numeric(12, 2) NOT NULL,
	"unit_cost" numeric(12, 2) NOT NULL
);

CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"channel" text NOT NULL,
	"user_id" integer,
	"reseller_id" integer,
	"attributed_reseller_id" integer,
	"attribution_source" text,
	"referral_code" text,
	"customer_first_name" text NOT NULL,
	"customer_surname" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_mobile" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"suburb" text,
	"city" text NOT NULL,
	"province" text NOT NULL,
	"postal_code" text NOT NULL,
	"bottles" integer NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"shipping_fee" numeric(12, 2) NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"wholesale_value" numeric(12, 2) NOT NULL,
	"cost_value" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"payment_method" text NOT NULL,
	"payment_reference" text,
	"period" text,
	"paid_at" timestamp with time zone,
	"courier" text,
	"tracking_number" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"shopify_order_id" text,
	"checkout_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_shopify_order_id_unique" UNIQUE("shopify_order_id")
);

CREATE TABLE "payouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"payout_number" text NOT NULL,
	"reseller_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"entry_count" integer NOT NULL,
	"reference" text,
	"status" text DEFAULT 'paid' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_payout_number_unique" UNIQUE("payout_number")
);

CREATE TABLE "period_runs" (
	"period" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_by" integer,
	"reseller_count" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"family" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"scent_profile" text DEFAULT '' NOT NULL,
	"top_notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"middle_notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"base_notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"keywords" text DEFAULT '' NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"image_alt" text DEFAULT '' NOT NULL,
	"size" text NOT NULL,
	"retail_price" numeric(12, 2) NOT NULL,
	"recommended_retail_price" numeric(12, 2) NOT NULL,
	"reseller_price" numeric(12, 2) NOT NULL,
	"cost" numeric(12, 2) NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 10 NOT NULL,
	"is_best_seller" boolean DEFAULT false NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"shopify_variant_id" text,
	"seo_title" text,
	"seo_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);

CREATE TABLE "qualification_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"reseller_id" integer NOT NULL,
	"period" text NOT NULL,
	"personal_bottles" integer NOT NULL,
	"personal_sales" numeric(12, 2) NOT NULL,
	"team_bottles" integer NOT NULL,
	"team_sales" numeric(12, 2) NOT NULL,
	"org_bottles" integer NOT NULL,
	"org_sales" numeric(12, 2) NOT NULL,
	"active_directs" integer NOT NULL,
	"inactive_directs" integer NOT NULL,
	"active_team_leaders" integer NOT NULL,
	"active_managers" integer NOT NULL,
	"org_active_resellers" integer NOT NULL,
	"is_active" boolean NOT NULL,
	"qualified_rank" text NOT NULL,
	"rank_before" text NOT NULL,
	"rank_after" text NOT NULL,
	"warning" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "referral_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"reseller_id" integer NOT NULL,
	"source" text DEFAULT 'link' NOT NULL,
	"visitor_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "reseller_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"user_id" integer,
	"first_name" text NOT NULL,
	"surname" text NOT NULL,
	"mobile" text NOT NULL,
	"email" text NOT NULL,
	"province" text NOT NULL,
	"city" text NOT NULL,
	"contact_method" text NOT NULL,
	"heard_about" text NOT NULL,
	"referring_code" text,
	"terms_accepted" boolean NOT NULL,
	"privacy_accepted" boolean NOT NULL,
	"reseller_terms_accepted" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_applications_application_id_unique" UNIQUE("application_id")
);

CREATE TABLE "resellers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"application_id" integer,
	"reseller_code" text NOT NULL,
	"referral_code" text NOT NULL,
	"sponsor_id" integer,
	"rank" text DEFAULT 'reseller' NOT NULL,
	"rank_locked" boolean DEFAULT false NOT NULL,
	"rank_warning_months" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"standing" text DEFAULT 'good' NOT NULL,
	"opening_order_completed" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_order_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resellers_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "resellers_reseller_code_unique" UNIQUE("reseller_code"),
	CONSTRAINT "resellers_referral_code_unique" UNIQUE("referral_code")
);

CREATE TABLE "site_content" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "uploaded_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" text NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text,
	"email" text NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"surname" text DEFAULT '' NOT NULL,
	"mobile" text,
	"role" text DEFAULT 'customer' NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"address_line1" text,
	"address_line2" text,
	"suburb" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE "wishlist_items" (
	"user_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlist_items_user_id_product_id_pk" PRIMARY KEY("user_id","product_id")
);

ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_seller_reseller_id_resellers_id_fk" FOREIGN KEY ("seller_reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_beneficiary_reseller_id_resellers_id_fk" FOREIGN KEY ("beneficiary_reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_reversal_of_id_commission_ledger_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."commission_ledger"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "commission_ledger" ADD CONSTRAINT "commission_ledger_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "fraud_flags" ADD CONSTRAINT "fraud_flags_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "fraud_flags" ADD CONSTRAINT "fraud_flags_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "fraud_flags" ADD CONSTRAINT "fraud_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_attributed_reseller_id_resellers_id_fk" FOREIGN KEY ("attributed_reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "period_runs" ADD CONSTRAINT "period_runs_run_by_users_id_fk" FOREIGN KEY ("run_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "qualification_periods" ADD CONSTRAINT "qualification_periods_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "referral_visits" ADD CONSTRAINT "referral_visits_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reseller_applications" ADD CONSTRAINT "reseller_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "reseller_applications" ADD CONSTRAINT "reseller_applications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_application_id_reseller_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."reseller_applications"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_sponsor_id_resellers_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");
CREATE UNIQUE INDEX "ledger_accrual_uq" ON "commission_ledger" USING btree ("order_item_id","beneficiary_reseller_id","kind") WHERE entry_type = 'accrual' and status <> 'void';
CREATE INDEX "ledger_beneficiary_idx" ON "commission_ledger" USING btree ("beneficiary_reseller_id");
CREATE INDEX "ledger_period_idx" ON "commission_ledger" USING btree ("period");
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");
CREATE INDEX "orders_period_idx" ON "orders" USING btree ("period");
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("customer_email");
CREATE INDEX "orders_reseller_idx" ON "orders" USING btree ("reseller_id");
CREATE INDEX "orders_attributed_idx" ON "orders" USING btree ("attributed_reseller_id");
CREATE INDEX "products_category_idx" ON "products" USING btree ("category");
CREATE INDEX "products_family_idx" ON "products" USING btree ("family");
CREATE UNIQUE INDEX "qp_reseller_period_uq" ON "qualification_periods" USING btree ("reseller_id","period");
CREATE INDEX "referral_visits_reseller_idx" ON "referral_visits" USING btree ("reseller_id");
CREATE INDEX "resellers_sponsor_idx" ON "resellers" USING btree ("sponsor_id");
CREATE INDEX "users_mobile_idx" ON "users" USING btree ("mobile");
