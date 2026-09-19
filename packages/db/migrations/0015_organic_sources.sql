-- ===========================================================================
-- GA4 and Search Console, at the grain each API actually reports.
--
-- Two tables rather than one, because the two sources measure different things
-- and a shared table would be half nulls down the middle: Search Console has
-- impressions and a ranking position and no notion of a session; GA4 has
-- sessions and engagement and no notion of a query. Nullable columns are right
-- where a platform is missing *one* figure its neighbour reports (see
-- `daily_metrics.reach`); they are the wrong answer when the two vocabularies
-- barely overlap.
--
-- Both are **channel-level sources and neither enters the attribution join**.
-- The GA4 Data API exposes no identifier for a person or a session — no
-- `clientId`, no `sessionId` — so a session can never be joined to the lead it
-- became, and Search Console reports queries and pages and never users at all.
-- Nothing downstream may divide a figure in either table into a funded deal.
-- See `docs/brief-amendments.md`, "§7 and §9 — GA4 and Search Console".
--
-- One row per day per dimension value, which is what makes any window
-- re-computable from stored rows. `dimension = 'total'` carries the day's
-- authoritative total: the per-dimension rows are the top N of that day and do
-- not sum to it, and the pages state that coverage rather than implying the
-- breakdown is exhaustive.
--
-- **No CTR column, deliberately.** CTR is clicks over impressions and is
-- derived at read time by `ctr()` in `@zeeraa/core`. Storing it would put a
-- ratio in a column that a `sum()` would silently destroy — the aggregate of
-- twelve daily CTRs is not the window's CTR.
--
-- **`position` is stored per row and must never be averaged plainly.** Search
-- Console reports an average position weighted by impressions; the mean of
-- daily positions weights a day with three impressions the same as a day with
-- three thousand. `weightedPosition()` in `@zeeraa/core` is the only correct
-- aggregation and is unit-tested against exactly that error.
-- ===========================================================================

CREATE TABLE "ga4_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	-- 'total' | 'landing_page' | 'source_medium'. Text rather than an enum: the
	-- vocabulary grows with each dimension a client asks for, and that should be
	-- a connector change rather than a migration.
	"dimension" text NOT NULL,
	-- GA4's own value, verbatim — including its placeholders, `(not set)`,
	-- `(direct) / (none)` and `(data not available)`. Those are facts about the
	-- property's data quality and are rendered as themselves, never cleaned away.
	"dimension_value" text NOT NULL,
	"sessions" numeric(20, 0) DEFAULT '0' NOT NULL,
	"engaged_sessions" numeric(20, 0) DEFAULT '0' NOT NULL,
	"users" numeric(20, 0) DEFAULT '0' NOT NULL,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "search_console_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"date" date NOT NULL,
	-- 'total' | 'query' | 'page'.
	"dimension" text NOT NULL,
	"dimension_value" text NOT NULL,
	"clicks" numeric(20, 0) DEFAULT '0' NOT NULL,
	"impressions" numeric(20, 0) DEFAULT '0' NOT NULL,
	-- Average ranking position for this row, as reported. Impression-weighted
	-- when aggregated; never averaged plainly.
	"position" numeric(10, 4),
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "ga4_metrics" ADD CONSTRAINT "ga4_metrics_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_metrics" ADD CONSTRAINT "ga4_metrics_sync_run_id_sync_runs_id_fk"
  FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_console_metrics" ADD CONSTRAINT "search_console_metrics_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_console_metrics" ADD CONSTRAINT "search_console_metrics_sync_run_id_sync_runs_id_fk"
  FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Upsert, never append. Both APIs restate: GA4 reprocesses for about 48 hours
-- and Search Console finalises over two to three days, so the nightly re-pull
-- has to converge on one row rather than add a second.
CREATE UNIQUE INDEX "ga4_metrics_upsert_key" ON "ga4_metrics"
  USING btree ("tenant_id","date","dimension","dimension_value");--> statement-breakpoint
CREATE INDEX "ga4_metrics_tenant_dimension_date_idx" ON "ga4_metrics"
  USING btree ("tenant_id","dimension","date");--> statement-breakpoint
CREATE UNIQUE INDEX "search_console_metrics_upsert_key" ON "search_console_metrics"
  USING btree ("tenant_id","date","dimension","dimension_value");--> statement-breakpoint
CREATE INDEX "search_console_metrics_tenant_dimension_date_idx" ON "search_console_metrics"
  USING btree ("tenant_id","dimension","date");--> statement-breakpoint

-- Hand-written from here down, so the exact USING/WITH CHECK clauses are
-- reviewable in this diff. The same treatment every tenant-scoped table gets.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ga4_metrics TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ga4_metrics TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.ga4_metrics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.ga4_metrics FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.ga4_metrics
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.ga4_metrics
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ga4_metrics TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.ga4_metrics
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON public.search_console_metrics TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.search_console_metrics TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.search_console_metrics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.search_console_metrics FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.search_console_metrics
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.search_console_metrics
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.search_console_metrics TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.search_console_metrics
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
