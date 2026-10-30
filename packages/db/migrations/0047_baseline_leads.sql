-- ===========================================================================
-- `baseline_leads`: which leads a frozen month's lead counts were made of
-- (30 October 2026).
--
-- A frozen figure is a total. When Spartan merges duplicate leads in
-- Salesforce after a month is frozen, the month's lead and MQL counts move,
-- and the deploy's number check fails until somebody restates them by hand —
-- because a total cannot say which leads moved, nor whether the code or the
-- record moved them. This table records, each time a month's channel figures
-- are frozen or corrected, every lead created in the month: its channel,
-- whether it was counted and qualified, and the fields Salesforce supplies that
-- a merge or a source edit changes. A lead that has since moved between
-- figures, and whose Salesforce fields have changed (merged away, merged into,
-- its creation date or source edited, deleted), is a Salesforce-proven change;
-- one that moved with the same fields was moved by the code, and still blocks
-- the deploy. Fields the code derives (channel, the MQL verdict, the revenue
-- band, the exclusion) are recorded as outcomes, never as evidence.
--
-- The current recording for a month is the one with the latest `recorded_at`.
--
-- **Append-only, for every role**, like `baseline_snapshots` (0032), whose
-- trigger function it shares: a ledger that could be rewritten would prove
-- whatever it was rewritten to.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "baseline_leads" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	-- First day of the frozen month.
	"month" date NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"external_id" text NOT NULL,
	"created_on" date NOT NULL,
	-- `coalesce(channel, click_id_type)`, as every lead count reads it; null is Direct & other.
	"channel" text,
	-- `excluded_reason is null`.
	"counted" boolean NOT NULL,
	-- `mql_verdict = 'qualified'`.
	"qualified" boolean NOT NULL,
	-- Salesforce's own fields, as stored: the instant it was created (a merge
	-- moves it), the lead it was merged into, the leads merged into it (sorted,
	-- comma-separated), the Lead Source picklist, and an md5 of the click, UTM,
	-- page, revenue and conversion fields (`baselineLeadEvidence`).
	"created_at" timestamp with time zone NOT NULL,
	"merged_into" text,
	"merged_from" text,
	"lead_source" text,
	"fields_hash" text NOT NULL,
	"recorded_by" text NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "baseline_leads_pkey" PRIMARY KEY ("tenant_id", "month", "recorded_at", "external_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "baseline_leads_external_idx"
  ON "baseline_leads" USING btree ("tenant_id", "external_id");--> statement-breakpoint

GRANT SELECT, INSERT ON public.baseline_leads TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.baseline_leads TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT ON public.baseline_leads TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.baseline_leads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.baseline_leads FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.baseline_leads
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

-- Insert only, as on baseline_snapshots.
CREATE POLICY tenant_admin_write ON public.baseline_leads
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.baseline_leads
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY job_tenant_insert ON public.baseline_leads
  AS PERMISSIVE FOR INSERT TO zeeraa_jobs
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.baseline_leads
  AS PERMISSIVE FOR SELECT TO zeeraa_maintenance
  USING (app.is_maintenance());--> statement-breakpoint

DROP TRIGGER IF EXISTS baseline_leads_append_only ON public.baseline_leads;--> statement-breakpoint
CREATE TRIGGER baseline_leads_append_only
  BEFORE UPDATE OR DELETE ON public.baseline_leads
  FOR EACH ROW EXECUTE FUNCTION app.baseline_snapshots_append_only();
