-- ===========================================================================
-- The funded-deals list on the Google Ads and Meta pages (25 September 2026).
--
-- 1. `opportunities.name`: Salesforce's `Opportunity.Name`, read by the sync
--    from now on and filled for deals already stored by
--    `backfill-opportunity-names.ts`. Null until read — the list renders
--    "Not recorded", never an id dressed as a name.
--
-- 2. `platform_ads`: an ad's name by its platform id. A Meta lead's landing
--    URL carries the ad's id (the `landing_url_parameters` config row says
--    which parameter), and Meta serves no click lookup, so the Meta sync
--    resolves the ids its leads carry and stores a row only where Meta
--    confirms the id is an ad. The standard policy set (see 0028).
-- ===========================================================================

ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "platform_ads" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_ads_pkey" PRIMARY KEY ("tenant_id", "platform", "external_id")
);--> statement-breakpoint

GRANT SELECT ON public.platform_ads TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.platform_ads TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_ads TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.platform_ads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.platform_ads FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.platform_ads
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

CREATE POLICY tenant_admin_write ON public.platform_ads
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() = 'zeeraa_admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.platform_ads
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.platform_ads
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());
