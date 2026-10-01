ALTER TABLE "app_users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "plan" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "plan" SET DATA TYPE text USING "plan"::text;--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "plan" SET DEFAULT 'free';--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "platform" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_users" ALTER COLUMN "platform" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "reporter_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "platform" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "reports" ALTER COLUMN "platform" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE INDEX "reports_external_user_id_idx" ON "reports" USING btree ("external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_idempotency_key_idx" ON "reports" USING btree ("idempotency_key");--> statement-breakpoint
DROP TYPE "public"."app_user_plan";