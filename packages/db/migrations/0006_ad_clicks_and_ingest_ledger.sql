CREATE TYPE "public"."click_ingest_status" AS ENUM('pending', 'succeeded', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "ad_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"click_id" text NOT NULL,
	"reported_date" date NOT NULL,
	"campaign_id" uuid,
	"external_ad_group_id" text,
	"ad_network_type" text,
	"device" text,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "click_ingest_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"day" date NOT NULL,
	"status" "click_ingest_status" DEFAULT 'pending' NOT NULL,
	"clicks_written" numeric(12, 0) DEFAULT '0' NOT NULL,
	"attempts" numeric(4, 0) DEFAULT '0' NOT NULL,
	"last_error" text,
	"last_attempted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"sync_run_id" uuid
);
--> statement-breakpoint
ALTER TABLE "ad_clicks" ADD CONSTRAINT "ad_clicks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_clicks" ADD CONSTRAINT "ad_clicks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_clicks" ADD CONSTRAINT "ad_clicks_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_ingest_days" ADD CONSTRAINT "click_ingest_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_ingest_days" ADD CONSTRAINT "click_ingest_days_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_clicks_upsert_key" ON "ad_clicks" USING btree ("tenant_id","platform","click_id");--> statement-breakpoint
CREATE INDEX "ad_clicks_tenant_platform_date_idx" ON "ad_clicks" USING btree ("tenant_id","platform","reported_date");--> statement-breakpoint
CREATE INDEX "ad_clicks_tenant_campaign_idx" ON "ad_clicks" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "click_ingest_days_key" ON "click_ingest_days" USING btree ("tenant_id","platform","day");--> statement-breakpoint
CREATE INDEX "click_ingest_days_tenant_status_idx" ON "click_ingest_days" USING btree ("tenant_id","platform","status","day");--> statement-breakpoint

-- Hand-written from here down, so the exact USING/WITH CHECK clauses are
-- reviewable in this diff.

-- Both tables take the same treatment every other tenant-scoped table gets.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_clicks TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_clicks TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.ad_clicks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.ad_clicks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.ad_clicks
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.ad_clicks
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.click_ingest_days TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.click_ingest_days TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.click_ingest_days ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.click_ingest_days FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.click_ingest_days
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.click_ingest_days
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint

-- Ingestion writes both: the clicks themselves, and the ledger recording which
-- days have been claimed. Scoped to one tenant with no user, as every sync is.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_clicks TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.ad_clicks
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.click_ingest_days TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.click_ingest_days
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
