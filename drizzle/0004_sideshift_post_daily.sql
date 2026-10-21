CREATE TABLE "sideshift_post_daily" (
	"post_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"date" date NOT NULL,
	"views" bigint DEFAULT 0 NOT NULL,
	"likes" bigint DEFAULT 0 NOT NULL,
	"comments" bigint DEFAULT 0 NOT NULL,
	"shares" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sideshift_post_daily_post_id_campaign_id_date_pk" PRIMARY KEY("post_id","campaign_id","date")
);
--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD CONSTRAINT "sideshift_post_daily_post_id_sideshift_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."sideshift_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sideshift_post_daily" ADD CONSTRAINT "sideshift_post_daily_campaign_id_sideshift_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."sideshift_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sideshift_post_daily_campaign_date_idx" ON "sideshift_post_daily" USING btree ("campaign_id","date");--> statement-breakpoint
-- Campaigns tracked before this table existed have no per-post history yet.
-- Clearing the backfill marker makes the next sync re-read a full year into
-- both daily tables.
UPDATE "sideshift_campaigns" SET "history_backfilled_at" = NULL;
