CREATE TYPE "public"."integration_provider" AS ENUM('revenuecat');--> statement-breakpoint
CREATE TABLE "dashboard_layouts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"widgets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_integrations" (
	"provider" "integration_provider" PRIMARY KEY NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hint" text NOT NULL,
	"external_id" text,
	"external_name" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_integrations" ADD CONSTRAINT "provider_integrations_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;