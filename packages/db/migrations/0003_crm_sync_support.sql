CREATE TYPE "public"."click_id_source" AS ENUM('opportunity_field', 'lead_conversion');--> statement-breakpoint
CREATE TYPE "public"."stage_origin" AS ENUM('observed', 'computed');--> statement-breakpoint
CREATE TABLE "opportunity_click_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"opportunity_external_id" text NOT NULL,
	"platform" text NOT NULL,
	"click_id" text NOT NULL,
	"source" "click_id_source" NOT NULL,
	"lead_external_id" text,
	"sync_run_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "converted_opportunity_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "merged_into" text;--> statement-breakpoint
ALTER TABLE "stage_events" ADD COLUMN "origin" "stage_origin" DEFAULT 'observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunity_click_ids" ADD CONSTRAINT "opportunity_click_ids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_click_ids" ADD CONSTRAINT "opportunity_click_ids_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_click_ids_upsert_key" ON "opportunity_click_ids" USING btree ("tenant_id","opportunity_external_id","platform","source");--> statement-breakpoint
CREATE INDEX "opportunity_click_ids_tenant_platform_idx" ON "opportunity_click_ids" USING btree ("tenant_id","platform");--> statement-breakpoint
CREATE INDEX "leads_tenant_converted_opp_idx" ON "leads" USING btree ("tenant_id","converted_opportunity_id");--> statement-breakpoint
-- ===========================================================================
-- A role for background jobs.
--
-- Ingestion writes on nobody's behalf. It cannot use `withTenant`, because
-- every policy there asks whether the current *user* holds a membership, and a
-- sync has no user. The wrong fixes are both available and both bad: give the
-- job a maintenance-role connection and it can write to every tenant at once;
-- invent a service user with memberships everywhere and the audit trail says a
-- person did it.
--
-- So `zeeraa_jobs` is scoped to a tenant but not to a user. It still cannot
-- touch two tenants in one transaction, which is the property that matters —
-- a bug in a connector corrupts one client's numbers, never two clients'.
--
-- It is not a member of zeeraa_maintenance, so the maintenance door is shut to
-- it, and it has no access to the identity tables at all.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zeeraa_jobs') THEN
    CREATE ROLE zeeraa_jobs NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA app TO zeeraa_jobs;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO zeeraa_jobs;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id(),
  app.claimed_role(), app.is_maintenance() TO zeeraa_jobs;--> statement-breakpoint

DO $$
DECLARE
  t text;
  -- Only what ingestion writes. Notably absent: assets, comments, mentions,
  -- notifications, memberships, connections and the identity tables. A sync has
  -- no business in any of them, so it cannot reach them even by accident.
  job_tables text[] := ARRAY[
    'ad_accounts','campaigns','daily_metrics','organic_metrics','ai_visibility',
    'leads','opportunities','stage_events','attribution','opportunity_click_ids',
    'sync_runs','data_sources','activity_log'
  ];
BEGIN
  FOREACH t IN ARRAY job_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO zeeraa_jobs', t);
    EXECUTE format($f$
      CREATE POLICY job_tenant_isolation ON public.%I
        AS PERMISSIVE FOR ALL TO zeeraa_jobs
        USING (tenant_id = app.current_tenant_id())
        WITH CHECK (tenant_id = app.current_tenant_id())
    $f$, t);
  END LOOP;
END $$;--> statement-breakpoint

-- Jobs read configuration; they never write it.
GRANT SELECT ON public.tenants, public.funnel_stages, public.tenant_config,
  public.tenant_metrics, public.connections TO zeeraa_jobs;--> statement-breakpoint

CREATE POLICY job_read_tenant ON public.tenants
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY job_read_config ON public.tenant_config
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY job_read_stages ON public.funnel_stages
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY job_read_metrics ON public.tenant_metrics
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY job_read_connections ON public.connections
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

-- The new table takes the same policies as every other tenant-scoped table.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.opportunity_click_ids TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.opportunity_click_ids TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.opportunity_click_ids ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.opportunity_click_ids FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.opportunity_click_ids
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.opportunity_click_ids
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());
