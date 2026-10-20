CREATE TYPE "public"."sideshift_connection_status" AS ENUM('disconnected', 'connected', 'needs_reconnect', 'subscription_inactive');--> statement-breakpoint
CREATE TABLE "sideshift_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"tracked" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"history_backfilled_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sideshift_connection" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"status" "sideshift_connection_status" DEFAULT 'disconnected' NOT NULL,
	"client_id" text,
	"client_secret_encrypted" text,
	"registration_access_token_encrypted" text,
	"redirect_uri" text,
	"access_token_encrypted" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_encrypted" text,
	"scope" text,
	"company_id" text,
	"company_name" text,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone,
	"oauth_state_hash" text,
	"oauth_verifier_encrypted" text,
	"oauth_started_at" timestamp with time zone,
	"oauth_started_by_user_id" text,
	"sync_started_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_error_request_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sideshift_creators" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sideshift_daily" (
	"campaign_id" text NOT NULL,
	"date" date NOT NULL,
	"views" bigint DEFAULT 0 NOT NULL,
	"likes" bigint DEFAULT 0 NOT NULL,
	"comments" bigint DEFAULT 0 NOT NULL,
	"shares" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sideshift_daily_campaign_id_date_pk" PRIMARY KEY("campaign_id","date")
);
--> statement-breakpoint
CREATE TABLE "sideshift_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"creator_id" text,
	"creator_handle" text,
	"creator_name" text,
	"title" text,
	"thumbnail_url" text,
	"post_url" text,
	"uploaded_at" timestamp with time zone,
	"views" bigint DEFAULT 0 NOT NULL,
	"likes" bigint DEFAULT 0 NOT NULL,
	"comments" bigint DEFAULT 0 NOT NULL,
	"shares" bigint DEFAULT 0 NOT NULL,
	"campaign_ids" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sideshift_connection" ADD CONSTRAINT "sideshift_connection_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_daily" ADD CONSTRAINT "sideshift_daily_campaign_id_sideshift_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sideshift_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sideshift_posts_campaign_ids_idx" ON "sideshift_posts" USING gin ("campaign_ids");--> statement-breakpoint
CREATE INDEX "sideshift_posts_uploaded_at_idx" ON "sideshift_posts" USING btree ("uploaded_at");