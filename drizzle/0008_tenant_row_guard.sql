-- A tenant may update its own tenants row (row security allows it, for the
-- ticket and report counters), but only the columns that are its business.
-- Its plan, status, subscription and identity are set by staff or by the
-- Stripe webhook (which runs as staff), so a bug or an injection in tenant
-- scoped code still cannot lift a suspension or grant itself a paid tier.
--
-- Migrations run as a superuser and are not held to this.
CREATE FUNCTION "tenants_guard_update"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF coalesce(current_setting('app.staff', true), '') = 'true'
		OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
		RETURN NEW;
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.slug IS DISTINCT FROM OLD.slug
		OR NEW.status IS DISTINCT FROM OLD.status
		OR NEW.plan IS DISTINCT FROM OLD.plan
		OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
		OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
		OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
		OR NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
		OR NEW.signup_source IS DISTINCT FROM OLD.signup_source
		OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
		-- The Stripe customer is attached once, never swapped.
		OR (OLD.stripe_customer_id IS NOT NULL
			AND NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id)
		-- A pending plan can be given up, not chosen, from the panel.
		OR (NEW.pending_plan IS NOT NULL
			AND NEW.pending_plan IS DISTINCT FROM OLD.pending_plan)
		OR (NEW.pending_interval IS NOT NULL
			AND NEW.pending_interval IS DISTINCT FROM OLD.pending_interval)
	THEN
		RAISE EXCEPTION 'tenant scope may not change this account setting'
			USING ERRCODE = 'insufficient_privilege';
	END IF;

	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "tenants_guard_update"
	BEFORE UPDATE ON "tenants"
	FOR EACH ROW EXECUTE FUNCTION "tenants_guard_update"();
