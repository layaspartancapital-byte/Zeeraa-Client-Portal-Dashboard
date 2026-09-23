-- ===========================================================================
-- Two tables from the accuracy audit of 23 September 2026.
--
-- 1. `reconciliation_checks`: each day, our totals against each source's own,
--    per source, metric and window. The latest state per key, upserted by the
--    daily job; the Connections screen reads it and names the drift.
--
-- 2. `baseline_snapshots`: the audited pre-engagement months, frozen. The ramp
--    reads a frozen month from here instead of recomputing it, so a later
--    re-sync — a restatement, a deletion, a re-attribution — cannot change the
--    baseline silently; the daily job still recomputes it and reports any
--    difference as drift from the frozen value.
--
--    **Append-only, for every role.** No policy admits UPDATE or DELETE, and
--    the trigger below refuses both even to a role no policy binds (the
--    owner, maintenance), because an edited baseline is exactly what this
--    table exists to prevent. A correction is a new row with the next
--    `version` and a `reason`. The one deletion allowed is the whole tenant's,
--    told apart through `app.tenant_index` the way 0027's last-admin trigger
--    does.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "reconciliation_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"metric" text NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"ours" numeric(20, 4),
	"theirs" numeric(20, 4),
	"difference" numeric(20, 4),
	"tolerance" numeric(20, 4) DEFAULT 0 NOT NULL,
	-- match | drift | explained | error
	"status" text NOT NULL,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_checks_status_check"
	  CHECK ("status" IN ('match', 'drift', 'explained', 'error'))
);--> statement-breakpoint

ALTER TABLE "reconciliation_checks"
  ADD CONSTRAINT "reconciliation_checks_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "reconciliation_checks_key"
  ON "reconciliation_checks" USING btree ("tenant_id","source","metric","window_start","window_end");--> statement-breakpoint

GRANT SELECT ON public.reconciliation_checks TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_checks TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reconciliation_checks TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.reconciliation_checks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.reconciliation_checks FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.reconciliation_checks
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

CREATE POLICY tenant_admin_write ON public.reconciliation_checks
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() = 'zeeraa_admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.reconciliation_checks
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.reconciliation_checks
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "baseline_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	-- First day of the frozen month.
	"month" date NOT NULL,
	"platform" text NOT NULL,
	-- The ramp metric key: costPerFundedDeal, cpa, budget, approvals, fundedDeals, fundedAmount.
	"metric" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	-- Null where the month was not measurable; `not_measured_reason` says why.
	"value" numeric(20, 4),
	"not_measured_reason" text,
	-- The metric's inputs, so the frozen figure can be re-derived and audited.
	"channel_spend" numeric(20, 4),
	"attributed" numeric(20, 4),
	"unattributed" numeric(20, 4),
	"attributed_elsewhere" numeric(20, 4),
	"range_low" numeric(20, 4),
	"range_high" numeric(20, 4),
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_by" text NOT NULL,
	-- Why this version exists: "audited 23 September 2026", or the correction.
	"reason" text NOT NULL
);--> statement-breakpoint

ALTER TABLE "baseline_snapshots"
  ADD CONSTRAINT "baseline_snapshots_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "baseline_snapshots_key"
  ON "baseline_snapshots" USING btree ("tenant_id","month","platform","metric","version");--> statement-breakpoint

-- INSERT for the next version by a Zeeraa admin (the policy below narrows it
-- to that role); never UPDATE or DELETE, for anybody.
GRANT SELECT, INSERT ON public.baseline_snapshots TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.baseline_snapshots TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT ON public.baseline_snapshots TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.baseline_snapshots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.baseline_snapshots FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.baseline_snapshots
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

-- Insert only, even for a Zeeraa admin: the policy set CLAUDE.md requires,
-- narrowed to the one command a frozen table may take.
CREATE POLICY tenant_admin_write ON public.baseline_snapshots
  AS PERMISSIVE FOR INSERT TO zeeraa_app
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.baseline_snapshots
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY job_tenant_insert ON public.baseline_snapshots
  AS PERMISSIVE FOR INSERT TO zeeraa_jobs
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.baseline_snapshots
  AS PERMISSIVE FOR SELECT TO zeeraa_maintenance
  USING (app.is_maintenance());--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.baseline_snapshots_append_only() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  begin
    -- The whole tenant is going: its tenant_index row is removed BEFORE the
    -- delete, so the cascade finds it gone and passes.
    if tg_op = 'DELETE' and not exists (select 1 from app.tenant_index t where t.id = old.tenant_id) then
      return old;
    end if;
    raise exception 'a frozen baseline is not edited; insert the next version with a reason'
      using errcode = '42501';
  end;
  $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS baseline_snapshots_append_only ON public.baseline_snapshots;--> statement-breakpoint
CREATE TRIGGER baseline_snapshots_append_only
  BEFORE UPDATE OR DELETE ON public.baseline_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.baseline_snapshots_append_only();--> statement-breakpoint

REVOKE ALL ON FUNCTION app.baseline_snapshots_append_only() FROM public;--> statement-breakpoint

-- The freeze runs on the ingestion role and has to know which channel the
-- ramp is contracted for. Read-only, and only the tenant in context — the
-- shape funnel_stages and tenant_config already have for the jobs.
GRANT SELECT ON public.engagement_targets TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_read_targets ON public.engagement_targets
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());
