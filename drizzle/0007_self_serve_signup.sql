-- Self-serve sign up and Stripe subscriptions.
--
-- Accounts can now be created by their owner through /signup and pay for a
-- tier through Stripe. The tenant row records the subscription and, until
-- checkout completes, the paid tier the owner picked.
--
-- Staff access is narrowed to what account management needs: super admins
-- manage accounts but never see or change what is in them.
--
-- Sign in now requires a verified email. Every existing login was created by
-- an invite or by staff and has been in use, so all of them count as
-- verified; without this they would be locked out.

CREATE TYPE "public"."billing_interval" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."signup_source" AS ENUM('admin', 'self_serve');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pending_plan" "plan_tier";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pending_interval" "billing_interval";--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "signup_source" "signup_source" DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id");--> statement-breakpoint
DROP POLICY "activity_log_staff_access" ON "activity_log" CASCADE;--> statement-breakpoint
DROP POLICY "app_settings_staff_access" ON "app_settings" CASCADE;--> statement-breakpoint
DROP POLICY "apps_staff_access" ON "apps" CASCADE;--> statement-breakpoint
CREATE POLICY "activity_log_staff_read" ON "activity_log" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.staff', true), '') = 'true' and "activity_log"."section" = 'admin');--> statement-breakpoint
CREATE POLICY "activity_log_staff_insert" ON "activity_log" AS PERMISSIVE FOR INSERT TO public WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "app_settings_staff_insert" ON "app_settings" AS PERMISSIVE FOR INSERT TO public WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "apps_staff_read" ON "apps" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint
CREATE POLICY "apps_staff_insert" ON "apps" AS PERMISSIVE FOR INSERT TO public WITH CHECK (nullif(current_setting('app.staff', true), '') = 'true');--> statement-breakpoint
UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;
--> statement-breakpoint

-- Account usage for the admin console. Staff cannot read end user tables at
-- all, and that stays true: this function hands back counts and timestamps
-- per app, never a row, so super admins see how much an account uses Yak
-- without seeing who its users are or what they sent.
--
-- SECURITY DEFINER runs it as the migration owner, who is not bound by row
-- security; `row_security = off` makes it fail loudly rather than return
-- zeros if that ever stops being true. It refuses to run outside the staff
-- scope, so a tenant connection cannot use it to count other accounts.
CREATE FUNCTION "staff_app_usage"(p_tenant_ids text[])
RETURNS TABLE (
	tenant_id text,
	app_id text,
	synced_users bigint,
	events_total bigint,
	events_this_month bigint,
	active_users_this_month bigint,
	last_event_at timestamptz,
	reports_total bigint,
	reports_open bigint,
	reports_this_month bigint,
	active_api_keys bigint,
	api_key_last_used_at timestamptz,
	integrations text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
#variable_conflict use_column
DECLARE
	month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
	IF coalesce(current_setting('app.staff', true), '') <> 'true' THEN
		RAISE EXCEPTION 'staff_app_usage is only available to the staff scope'
			USING ERRCODE = 'insufficient_privilege';
	END IF;

	RETURN QUERY
	SELECT
		a.tenant_id,
		a.id,
		(SELECT count(*) FROM app_users u
			WHERE u.tenant_id = a.tenant_id AND u.app_id = a.id),
		(SELECT count(*) FROM analytics_events e
			WHERE e.tenant_id = a.tenant_id AND e.app_id = a.id),
		(SELECT count(*) FROM analytics_events e
			WHERE e.tenant_id = a.tenant_id AND e.app_id = a.id
			AND e.occurred_at >= month_start),
		(SELECT count(DISTINCT coalesce(e.external_user_id, e.anonymous_id)) FROM analytics_events e
			WHERE e.tenant_id = a.tenant_id AND e.app_id = a.id
			AND e.occurred_at >= month_start),
		(SELECT max(e.occurred_at) FROM analytics_events e
			WHERE e.tenant_id = a.tenant_id AND e.app_id = a.id),
		(SELECT count(*) FROM reports r
			WHERE r.tenant_id = a.tenant_id AND r.app_id = a.id),
		(SELECT count(*) FROM reports r
			WHERE r.tenant_id = a.tenant_id AND r.app_id = a.id
			AND r.status IN ('open', 'in_progress', 'waiting')),
		(SELECT count(*) FROM reports r
			WHERE r.tenant_id = a.tenant_id AND r.app_id = a.id
			AND r.created_at >= month_start),
		(SELECT count(*) FROM api_keys k
			WHERE k.tenant_id = a.tenant_id AND k.app_id = a.id
			AND k.revoked_at IS NULL
			AND (k.expires_at IS NULL OR k.expires_at > now())),
		(SELECT max(k.last_used_at) FROM api_keys k
			WHERE k.tenant_id = a.tenant_id AND k.app_id = a.id),
		(SELECT coalesce(array_agg(DISTINCT p.provider::text), '{}') FROM provider_integrations p
			WHERE p.tenant_id = a.tenant_id AND p.app_id = a.id)
	FROM apps a
	WHERE a.tenant_id = ANY (p_tenant_ids);
END
$$;
