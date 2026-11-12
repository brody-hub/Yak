-- Apps and row level security.
--
-- A customer account now holds any number of apps, and everything an app
-- sends (events, end users, reports) or sends with (API keys, RevenueCat)
-- belongs to exactly one of them. Every existing tenant gets one app that
-- reuses the tenant's id, name and slug, and all of its data is adopted by it.
--
-- Every customer table then gets row level security keyed to session settings
-- that the server sets per connection (see src/db/scope.ts). FORCE makes the
-- policies bind the table owner too; only superusers and BYPASSRLS roles are
-- exempt, which is why the application must not connect as one.
--
-- Run this, like every migration, as the table owner.

CREATE TYPE "public"."app_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."plan_tier" AS ENUM('free', 'starter', 'growth', 'pro', 'studio', 'scale');--> statement-breakpoint

-- Billing scaffolding. Tiers are placed by hand until Stripe drives them.
ALTER TABLE "tenants" ADD COLUMN "plan" "plan_tier" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint

CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "app_status" DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apps_tenant_id_id_unique" UNIQUE("tenant_id","id")
);--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_tenant_id_slug_idx" ON "apps" USING btree ("tenant_id","slug");--> statement-breakpoint

-- One app per existing tenant, reusing the tenant's identity so the adoption
-- below is a plain copy of tenant_id.
INSERT INTO "apps" ("id", "tenant_id", "name", "slug", "created_by_user_id", "created_at")
SELECT "id", "id", "name", "slug", "created_by_user_id", "created_at" FROM "tenants";--> statement-breakpoint

-- App-scoped tables: add app_id, adopt existing rows, then require it and tie
-- (tenant_id, app_id) to the app so a row can never point at another
-- tenant's app.
ALTER TABLE "analytics_events" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "analytics_events" SET "app_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "analytics_events" ALTER COLUMN "app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "api_keys" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "api_keys" SET "app_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "app_users" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "app_users" SET "app_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "reports" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "reports" SET "app_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "report_messages" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "report_messages" SET "app_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "report_messages" ALTER COLUMN "app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_messages" ADD CONSTRAINT "report_messages_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "provider_integrations" ADD COLUMN "app_id" text;--> statement-breakpoint
UPDATE "provider_integrations" SET "app_id" = "tenant_id";--> statement-breakpoint
ALTER TABLE "provider_integrations" ALTER COLUMN "app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_integrations" DROP CONSTRAINT "provider_integrations_tenant_id_provider_pk";--> statement-breakpoint
ALTER TABLE "provider_integrations" ADD CONSTRAINT "provider_integrations_tenant_id_app_id_provider_pk" PRIMARY KEY("tenant_id","app_id","provider");--> statement-breakpoint
ALTER TABLE "provider_integrations" ADD CONSTRAINT "provider_integrations_tenant_id_app_id_apps_tenant_id_id_fk" FOREIGN KEY ("tenant_id","app_id") REFERENCES "public"."apps"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Dashboard layouts belong to a panel user, and now to that user's tenant as
-- well so the table can carry the same policy as everything else. A layout
-- saved by a super admin has no tenant and is dropped.
ALTER TABLE "dashboard_layouts" ADD COLUMN "tenant_id" text;--> statement-breakpoint
UPDATE "dashboard_layouts" SET "tenant_id" = "user"."tenant_id" FROM "user" WHERE "user"."id" = "dashboard_layouts"."user_id";--> statement-breakpoint
DELETE FROM "dashboard_layouts" WHERE "tenant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Indexes lead with (tenant_id, app_id) now.
DROP INDEX "analytics_events_tenant_id_occurred_at_idx";--> statement-breakpoint
DROP INDEX "analytics_events_tenant_id_name_occurred_at_idx";--> statement-breakpoint
DROP INDEX "analytics_events_tenant_id_external_user_id_idx";--> statement-breakpoint
DROP INDEX "api_keys_tenant_id_idx";--> statement-breakpoint
DROP INDEX "app_users_tenant_id_external_id_idx";--> statement-breakpoint
DROP INDEX "app_users_tenant_id_email_idx";--> statement-breakpoint
DROP INDEX "app_users_tenant_id_name_idx";--> statement-breakpoint
DROP INDEX "reports_tenant_id_type_status_idx";--> statement-breakpoint
DROP INDEX "reports_tenant_id_idempotency_key_idx";--> statement-breakpoint
CREATE INDEX "analytics_events_app_occurred_at_idx" ON "analytics_events" USING btree ("tenant_id","app_id","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_app_name_occurred_at_idx" ON "analytics_events" USING btree ("tenant_id","app_id","name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_app_external_user_id_idx" ON "analytics_events" USING btree ("tenant_id","app_id","external_user_id");--> statement-breakpoint
CREATE INDEX "api_keys_app_idx" ON "api_keys" USING btree ("tenant_id","app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_app_external_id_idx" ON "app_users" USING btree ("tenant_id","app_id","external_id");--> statement-breakpoint
CREATE INDEX "app_users_app_email_idx" ON "app_users" USING btree ("tenant_id","app_id","email");--> statement-breakpoint
CREATE INDEX "app_users_app_name_idx" ON "app_users" USING btree ("tenant_id","app_id","name");--> statement-breakpoint
CREATE INDEX "reports_app_type_status_idx" ON "reports" USING btree ("tenant_id","app_id","type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_app_idempotency_key_idx" ON "reports" USING btree ("tenant_id","app_id","idempotency_key");--> statement-breakpoint

-- Row level security. Enabled last so the adoption above ran unrestricted.
ALTER TABLE "activity_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "apps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "apps" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discord_triggers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discord_triggers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_integrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_creators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_creators" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sideshift_posts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sprints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ticket_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tickets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Tenant isolation: a row is visible and writable only on a connection bound
-- to its tenant. With no tenant bound, nothing matches.
CREATE POLICY "activity_log_tenant_isolation" ON "activity_log" AS PERMISSIVE FOR ALL TO public USING ("activity_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("activity_log"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "analytics_events_tenant_isolation" ON "analytics_events" AS PERMISSIVE FOR ALL TO public USING ("analytics_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("analytics_events"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING ("api_keys"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("api_keys"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "app_settings_tenant_isolation" ON "app_settings" AS PERMISSIVE FOR ALL TO public USING ("app_settings"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("app_settings"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "app_users_tenant_isolation" ON "app_users" AS PERMISSIVE FOR ALL TO public USING ("app_users"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("app_users"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "apps_tenant_isolation" ON "apps" AS PERMISSIVE FOR ALL TO public USING ("apps"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("apps"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "dashboard_layouts_tenant_isolation" ON "dashboard_layouts" AS PERMISSIVE FOR ALL TO public USING ("dashboard_layouts"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("dashboard_layouts"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "discord_triggers_tenant_isolation" ON "discord_triggers" AS PERMISSIVE FOR ALL TO public USING ("discord_triggers"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("discord_triggers"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "provider_integrations_tenant_isolation" ON "provider_integrations" AS PERMISSIVE FOR ALL TO public USING ("provider_integrations"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("provider_integrations"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "report_messages_tenant_isolation" ON "report_messages" AS PERMISSIVE FOR ALL TO public USING ("report_messages"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("report_messages"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "reports_tenant_isolation" ON "reports" AS PERMISSIVE FOR ALL TO public USING ("reports"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("reports"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sideshift_campaigns_tenant_isolation" ON "sideshift_campaigns" AS PERMISSIVE FOR ALL TO public USING ("sideshift_campaigns"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sideshift_campaigns"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sideshift_connection_tenant_isolation" ON "sideshift_connection" AS PERMISSIVE FOR ALL TO public USING ("sideshift_connection"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sideshift_connection"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sideshift_creators_tenant_isolation" ON "sideshift_creators" AS PERMISSIVE FOR ALL TO public USING ("sideshift_creators"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sideshift_creators"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sideshift_daily_tenant_isolation" ON "sideshift_daily" AS PERMISSIVE FOR ALL TO public USING ("sideshift_daily"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sideshift_daily"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sideshift_post_daily_tenant_isolation" ON "sideshift_post_daily" AS PERMISSIVE FOR ALL TO public USING ("sideshift_post_daily"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sideshift_post_daily"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sideshift_posts_tenant_isolation" ON "sideshift_posts" AS PERMISSIVE FOR ALL TO public USING ("sideshift_posts"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sideshift_posts"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "sprints_tenant_isolation" ON "sprints" AS PERMISSIVE FOR ALL TO public USING ("sprints"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("sprints"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "ticket_history_tenant_isolation" ON "ticket_history" AS PERMISSIVE FOR ALL TO public USING ("ticket_history"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("ticket_history"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "tickets_tenant_isolation" ON "tickets" AS PERMISSIVE FOR ALL TO public USING ("tickets"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("tickets"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "webhook_deliveries_tenant_isolation" ON "webhook_deliveries" AS PERMISSIVE FOR ALL TO public USING ("webhook_deliveries"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("webhook_deliveries"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_isolation" ON "webhook_endpoints" AS PERMISSIVE FOR ALL TO public USING ("webhook_endpoints"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("webhook_endpoints"."tenant_id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint

-- Staff access: super admins setting up and managing accounts. Only account
-- metadata; the end user tables above have no such clause, so a staff
-- connection reads nothing from them.
CREATE POLICY "activity_log_staff_access" ON "activity_log" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.staff', true), '') = 'true') WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "app_settings_staff_access" ON "app_settings" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.staff', true), '') = 'true') WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "apps_staff_access" ON "apps" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.staff', true), '') = 'true') WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint

-- Lookup access: a credential being resolved before its tenant is known.
CREATE POLICY "api_keys_lookup_access" ON "api_keys" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.lookup', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "sideshift_connection_lookup_access" ON "sideshift_connection" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.lookup', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "apps_lookup_access" ON "apps" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.lookup', true), '') = 'true');--> statement-breakpoint

-- Tenants hold no end user data and must be readable while a session is
-- being resolved, before any scope exists, so reads stay open. Writes are
-- confined: a tenant may update only its own row, staff may do anything.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenants_read" ON "tenants" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "tenants_tenant_update" ON "tenants" AS PERMISSIVE FOR UPDATE TO public USING ("tenants"."id" = nullif(current_setting('app.tenant_id', true), '')) WITH CHECK ("tenants"."id" = nullif(current_setting('app.tenant_id', true), ''));--> statement-breakpoint
CREATE POLICY "tenants_staff_write" ON "tenants" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.staff', true), '') = 'true') WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');
