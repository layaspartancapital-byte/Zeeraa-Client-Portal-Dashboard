-- ===========================================================================
-- Which days each source has actually been read for, and whether the read
-- came after the day was over.
--
-- The audit of 23 September 2026 found Meta and GA4 with no rows at all for 19
-- and 20 September, and 18 September stored from a read taken before the day
-- ended and never refreshed. Nothing in the data said so: a sync run records
-- when it ran, not which days it covered, and the screens decided coverage from
-- the last run alone — so two unread days inside a month read as two quiet
-- ones.
--
-- One row per (tenant, platform, day) a successful pull covered. `final` is
-- whether that pull happened after the day had settled in the tenant's zone:
-- a day read while it was still in progress is covered but not final, and the
-- next run resumes from the oldest day that is not. Written by the ingestion
-- role only; the application reads it to mark unread days `Not measured`.
--
-- Also: `skipped` joins the sync statuses, so a platform the runner did not
-- reach leaves a row saying so instead of leaving nothing.
-- ===========================================================================

ALTER TYPE "public"."sync_status" ADD VALUE IF NOT EXISTS 'skipped';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sync_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"day" date NOT NULL,
	"final" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_run_id" uuid
);--> statement-breakpoint

ALTER TABLE "sync_days"
  ADD CONSTRAINT "sync_days_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "sync_days"
  ADD CONSTRAINT "sync_days_sync_run_id_sync_runs_id_fk"
  FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sync_days_tenant_platform_day_key"
  ON "sync_days" USING btree ("tenant_id","platform","day");--> statement-breakpoint

GRANT SELECT ON public.sync_days TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.sync_days TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sync_days TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.sync_days ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sync_days FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.sync_days
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

CREATE POLICY tenant_admin_write ON public.sync_days
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() = 'zeeraa_admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.sync_days
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.sync_days
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());
