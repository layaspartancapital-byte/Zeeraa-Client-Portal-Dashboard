-- ===========================================================================
-- The engagement ramp, as rows.
--
-- Zeeraa signs an engagement against a curve rather than a single number: an
-- eight-month decline in cost per funded deal, with a budget and volume targets
-- beside each month. Spartan's is Google Ads only — Meta carries no target, and
-- must not inherit one.
--
-- **Rows and not constants**, for the reason every threshold in this schema is
-- a row: this is what one client signed. The figures are per tenant and per
-- platform; the arithmetic that turns "month 3" into "October 2026" is in
-- `packages/core/src/ramp.ts`, where it is the same for every engagement.
--
-- `month_index` is 1-based and carries **no calendar meaning on its own**. M1
-- lands on whatever month the contract starts, which is recorded separately as
-- `engagement_start_month` in `tenant_config` and is set when the engagement is
-- signed. Until it is, the ramp is a shape with no position on the calendar and
-- the product says so rather than assuming the engagement began when ingestion
-- did. See `docs/brief-amendments.md`, "§12 — the hero tracks the engagement
-- ramp".
--
-- Every figure is nullable, and that is not laziness. The model states a
-- budget, a CPA, an approvals count and a funded-deal count per month; what has
-- been supplied so far is the eight cost-per-funded-deal figures and the first
-- month's budget. A column with no figure renders as an absence rather than as
-- a zero, like every other unmeasured thing here.
--
-- Additive, so it runs before the deploy.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "engagement_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	-- Connector key: `google_ads`. Never null — a target belongs to a channel,
	-- and a row without one would be a target for everything.
	"platform" text NOT NULL,
	"month_index" integer NOT NULL,
	"cost_per_funded_deal" numeric(18, 2),
	"budget" numeric(18, 2),
	"cpa" numeric(18, 2),
	"approvals" integer,
	"funded_deals" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- M0 would be the month before the engagement, which is not a thing the
	-- model describes. The upper bound is deliberately absent: an eight-month
	-- ramp is this contract, not a property of the schema.
	CONSTRAINT "engagement_targets_month_index_positive" CHECK ("month_index" >= 1)
);
--> statement-breakpoint

ALTER TABLE "engagement_targets"
  ADD CONSTRAINT "engagement_targets_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One row per channel per month. Two rows for the same month would be two
-- targets, and nothing downstream could choose between them.
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_targets_tenant_platform_month_key"
  ON "engagement_targets" USING btree ("tenant_id","platform","month_index");--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Grants and policies, in the shape every tenant-scoped table here carries.
--
-- No grant to `zeeraa_jobs`: ingestion writes what platforms report, and a
-- contracted target is not something a connector can produce. A sync that could
-- write here could move the goalposts it is measured against.
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.engagement_targets TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.engagement_targets TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.engagement_targets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.engagement_targets FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.engagement_targets
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.engagement_targets
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());--> statement-breakpoint
