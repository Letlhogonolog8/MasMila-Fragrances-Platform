-- Payment provenance: record which store sent each payment notification, the
-- webhook API version and Shopify's test flag, so a staging test purchase can
-- be shown to come from the real provider (docs/STAGING.md, S3).
--
-- Additive only: three nullable columns, no row changed. Existing rows keep
-- NULL (provenance unknown). Apply with the migration runner.

ALTER TABLE "payment_events" ADD COLUMN "shop_domain" text;
ALTER TABLE "payment_events" ADD COLUMN "api_version" text;
ALTER TABLE "payment_events" ADD COLUMN "test_payment" boolean;
