-- Multi-tenant conversion.
--
-- Until now one deployment served one customer. From here every customer-owned
-- row carries `tenant_id`. A database that already holds a customer's data has
-- all of it adopted by a tenant with id `default`, so an existing deployment
-- keeps working unchanged after this runs. An empty database gets no tenant;
-- super admins create them.
--
-- The new `super_admin` enum value is only ever compared as text below,
-- because Postgres will not use an enum value in the transaction that adds it.

ALTER TYPE "public"."user_role" ADD VALUE 'super_admin';--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"ticket_seq" integer DEFAULT 100 NOT NULL,
	"report_seq" integer DEFAULT 1000 NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);--> statement-breakpoint

-- Adopt existing data. Ticket and report numbers continue where the old
-- identity columns left off.
INSERT INTO "tenants" ("id", "name", "slug", "ticket_seq", "report_seq")
SELECT
	'default',
	coalesce((SELECT "brand_name" FROM "app_settings" LIMIT 1), 'Default'),
	'default',
	coalesce((SELECT max("number") FROM "tickets"), 100),
	coalesce((SELECT max("number") FROM "reports"), 1000)
WHERE
	EXISTS (SELECT 1 FROM "user")
	OR EXISTS (SELECT 1 FROM "sprints")
	OR EXISTS (SELECT 1 FROM "tickets")
	OR EXISTS (SELECT 1 FROM "reports")
	OR EXISTS (SELECT 1 FROM "analytics_events")
	OR EXISTS (SELECT 1 FROM "app_users")
	OR EXISTS (SELECT 1 FROM "api_keys")
	OR EXISTS (SELECT 1 FROM "app_settings")
	OR EXISTS (SELECT 1 FROM "discord_triggers")
	OR EXISTS (SELECT 1 FROM "webhook_endpoints")
	OR EXISTS (SELECT 1 FROM "provider_integrations")
	OR EXISTS (SELECT 1 FROM "sideshift_connection")
	OR EXISTS (SELECT 1 FROM "sideshift_campaigns")
	OR EXISTS (SELECT 1 FROM "sideshift_posts")
	OR EXISTS (SELECT 1 FROM "sideshift_creators");--> statement-breakpoint

-- Panel users. Super admins are the only users without a tenant.
ALTER TABLE "user" ADD COLUMN "tenant_id" text;--> statement-breakpoint
UPDATE "user" SET "tenant_id" = 'default';--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_matches_role" CHECK (("user"."role"::text = 'super_admin') = ("user"."tenant_id" is null));--> statement-breakpoint
CREATE INDEX "user_tenant_id_idx" ON "user" USING btree ("tenant_id");--> statement-breakpoint

ALTER TABLE "activity_log" ADD COLUMN "tenant_id" text;--> statement-breakpoint
UPDATE "activity_log" SET "tenant_id" = 'default';--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_tenant_id_created_at_idx" ON "activity_log" USING btree ("tenant_id","created_at");--> statement-breakpoint

-- Tables that simply gain a required tenant_id. The temporary default fills
-- existing rows (which only exist when the default tenant does) and is then
-- dropped so new rows must name their tenant.
ALTER TABLE "sprints" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sprints" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ticket_history" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "ticket_history" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "report_messages" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "report_messages" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_users" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "discord_triggers" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "discord_triggers" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "provider_integrations" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "provider_integrations" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sideshift_posts" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sideshift_posts" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sideshift_creators" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sideshift_creators" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sideshift_daily" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sideshift_daily" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint

-- Singleton rows become one row per tenant, keyed by tenant_id.
ALTER TABLE "app_settings" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_pkey";--> statement-breakpoint
ALTER TABLE "app_settings" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "app_settings" ADD PRIMARY KEY ("tenant_id");--> statement-breakpoint
ALTER TABLE "sideshift_connection" ADD COLUMN "tenant_id" text NOT NULL DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "sideshift_connection" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "sideshift_connection" DROP CONSTRAINT "sideshift_connection_pkey";--> statement-breakpoint
ALTER TABLE "sideshift_connection" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "sideshift_connection" ADD PRIMARY KEY ("tenant_id");--> statement-breakpoint
-- The OAuth callback no longer finishes a connection by itself; the code waits
-- here until the user who clicked Connect confirms from their own session.
ALTER TABLE "sideshift_connection" ADD COLUMN "oauth_code_encrypted" text;--> statement-breakpoint

-- Keys that were unique per deployment become unique per tenant. Sideshift ids
-- come from Sideshift, so two tenants can hold the same one.
ALTER TABLE "sideshift_daily" DROP CONSTRAINT "sideshift_daily_campaign_id_sideshift_campaigns_id_fk";--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" DROP CONSTRAINT "sideshift_post_daily_post_id_sideshift_posts_id_fk";--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" DROP CONSTRAINT "sideshift_post_daily_campaign_id_sideshift_campaigns_id_fk";--> statement-breakpoint
ALTER TABLE "discord_triggers" DROP CONSTRAINT "discord_triggers_pkey";--> statement-breakpoint
ALTER TABLE "provider_integrations" DROP CONSTRAINT "provider_integrations_pkey";--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" DROP CONSTRAINT "sideshift_campaigns_pkey";--> statement-breakpoint
ALTER TABLE "sideshift_posts" DROP CONSTRAINT "sideshift_posts_pkey";--> statement-breakpoint
ALTER TABLE "sideshift_creators" DROP CONSTRAINT "sideshift_creators_pkey";--> statement-breakpoint
ALTER TABLE "sideshift_daily" DROP CONSTRAINT "sideshift_daily_campaign_id_date_pk";--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" DROP CONSTRAINT "sideshift_post_daily_post_id_campaign_id_date_pk";--> statement-breakpoint
ALTER TABLE "discord_triggers" ADD CONSTRAINT "discord_triggers_tenant_id_trigger_pk" PRIMARY KEY("tenant_id","trigger");--> statement-breakpoint
ALTER TABLE "provider_integrations" ADD CONSTRAINT "provider_integrations_tenant_id_provider_pk" PRIMARY KEY("tenant_id","provider");--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" ADD CONSTRAINT "sideshift_campaigns_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sideshift_posts" ADD CONSTRAINT "sideshift_posts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sideshift_creators" ADD CONSTRAINT "sideshift_creators_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sideshift_daily" ADD CONSTRAINT "sideshift_daily_tenant_id_campaign_id_date_pk" PRIMARY KEY("tenant_id","campaign_id","date");--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD CONSTRAINT "sideshift_post_daily_tenant_id_post_id_campaign_id_date_pk" PRIMARY KEY("tenant_id","post_id","campaign_id","date");--> statement-breakpoint
ALTER TABLE "sideshift_daily" ADD CONSTRAINT "sideshift_daily_tenant_id_campaign_id_sideshift_campaigns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."sideshift_campaigns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD CONSTRAINT "sideshift_post_daily_tenant_id_post_id_sideshift_posts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."sideshift_posts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD CONSTRAINT "sideshift_post_daily_tenant_id_campaign_id_sideshift_campaigns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."sideshift_campaigns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Ticket and report numbers are handed out per tenant from tenants.*_seq.
ALTER TABLE "tickets" ALTER COLUMN "number" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "number" DROP IDENTITY;--> statement-breakpoint
DROP INDEX "tickets_number_idx";--> statement-breakpoint
DROP INDEX "reports_number_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_tenant_id_number_idx" ON "tickets" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_tenant_id_number_idx" ON "reports" USING btree ("tenant_id","number");--> statement-breakpoint

-- Indexes now lead with tenant_id, since every query filters on it.
DROP INDEX "reports_type_status_idx";--> statement-breakpoint
DROP INDEX "reports_idempotency_key_idx";--> statement-breakpoint
DROP INDEX "analytics_events_occurred_at_idx";--> statement-breakpoint
DROP INDEX "analytics_events_name_occurred_at_idx";--> statement-breakpoint
DROP INDEX "analytics_events_external_user_id_idx";--> statement-breakpoint
DROP INDEX "app_users_external_id_idx";--> statement-breakpoint
DROP INDEX "app_users_email_idx";--> statement-breakpoint
DROP INDEX "app_users_name_idx";--> statement-breakpoint
DROP INDEX "webhook_endpoints_enabled_idx";--> statement-breakpoint
DROP INDEX "sideshift_posts_uploaded_at_idx";--> statement-breakpoint
DROP INDEX "sideshift_post_daily_campaign_date_idx";--> statement-breakpoint
CREATE INDEX "reports_tenant_id_type_status_idx" ON "reports" USING btree ("tenant_id","type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_tenant_id_idempotency_key_idx" ON "reports" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "analytics_events_tenant_id_occurred_at_idx" ON "analytics_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_tenant_id_name_occurred_at_idx" ON "analytics_events" USING btree ("tenant_id","name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_tenant_id_external_user_id_idx" ON "analytics_events" USING btree ("tenant_id","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_tenant_id_external_id_idx" ON "app_users" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "app_users_tenant_id_email_idx" ON "app_users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "app_users_tenant_id_name_idx" ON "app_users" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_id_enabled_idx" ON "webhook_endpoints" USING btree ("tenant_id","enabled");--> statement-breakpoint
CREATE INDEX "sideshift_posts_tenant_id_uploaded_at_idx" ON "sideshift_posts" USING btree ("tenant_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "sideshift_post_daily_tenant_id_campaign_date_idx" ON "sideshift_post_daily" USING btree ("tenant_id","campaign_id","date");--> statement-breakpoint
CREATE INDEX "sprints_tenant_id_idx" ON "sprints" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ticket_history_tenant_id_created_at_idx" ON "ticket_history" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint

-- Foreign keys to tenants, added last so the backfilled rows are checked once.
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_history" ADD CONSTRAINT "ticket_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_messages" ADD CONSTRAINT "report_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_triggers" ADD CONSTRAINT "discord_triggers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_integrations" ADD CONSTRAINT "provider_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_connection" ADD CONSTRAINT "sideshift_connection_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" ADD CONSTRAINT "sideshift_campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_posts" ADD CONSTRAINT "sideshift_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_creators" ADD CONSTRAINT "sideshift_creators_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_daily" ADD CONSTRAINT "sideshift_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD CONSTRAINT "sideshift_post_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
