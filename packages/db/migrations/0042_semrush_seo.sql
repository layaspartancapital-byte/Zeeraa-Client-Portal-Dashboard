-- ===========================================================================
-- SEO, from Semrush (28 September 2026).
--
-- Replaces the earlier SEO plan in `docs/state.md`. One Semrush project per
-- tenant (Spartan: 29644497, www.spartancapitalgroup.com), read with Zeeraa's
-- API key, which is metered in units — so every read is logged with what it
-- cost (`seo_report_reads`), and that log is also what decides whether a
-- report is due again.
--
-- Semrush reports two kinds of thing, and the tables keep them apart:
--
--   * **Monthly snapshots** of the domain as Semrush's databases see it:
--     keywords, position bands, estimated traffic, AI Overview presence,
--     backlinks. One row per month, rewritten by each read in that month, so
--     the month in progress is always "as of" its `read_on` day. Semrush's own
--     history backfills the months before the first read.
--   * **Daily observations** from Position Tracking: each tracked keyword's
--     position on each day Semrush harvested it. Coverage for these is by day,
--     in `sync_days` under platform `semrush`, like every other daily source.
--
-- The site audit is stored per crawl snapshot (Semrush recrawls on its own
-- schedule, about fortnightly), keyed by its snapshot id, so re-reading the
-- same crawl changes nothing.
--
-- `organic_metrics` and `ai_visibility` are untouched: they may hold
-- hand-entered rows, and dropping a table with data in it is not this
-- migration's decision.
--
-- Every table: members read (`tenant_isolation`, FOR SELECT), a Zeeraa admin
-- writes, the ingestion role writes its own tenant, maintenance crosses
-- tenants. The standard set from 0028, listed rather than discovered so it is
-- reviewable here.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "seo_report_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	-- The report's name in `SEMRUSH_REPORTS` (core), e.g. 'domain_overview'.
	"report" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The tenant-local day of the read.
	"read_on" date NOT NULL,
	-- Units the read cost, from Semrush's own balance before and after, or the
	-- documented price where the balance could not be read.
	"units" integer NOT NULL,
	"rows" integer NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_report_reads_tenant_report_idx"
  ON "seo_report_reads" ("tenant_id", "report", "read_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_domain_months" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	-- Semrush's regional database, 'us' for Spartan.
	"database" text NOT NULL,
	-- First day of the month the snapshot describes.
	"month" date NOT NULL,
	-- The day it was read. For a past month from Semrush's history this is the
	-- backfill day; for the month in progress, the latest read.
	"read_on" date NOT NULL,
	"semrush_rank" integer,
	"organic_keywords" integer NOT NULL,
	"positions_1_3" integer NOT NULL,
	"positions_4_10" integer NOT NULL,
	"positions_11_20" integer NOT NULL,
	-- Semrush's estimate of monthly organic visits, not a measurement.
	"organic_traffic" integer NOT NULL,
	"organic_traffic_cost" numeric(14, 2) NOT NULL,
	-- Ranking keywords whose results page shows an AI Overview (FK52).
	"ai_overview_keywords" integer NOT NULL,
	-- Citations of the domain inside AI Overviews (FP52): one per keyword and
	-- cited URL, so a keyword citing two of its pages counts twice.
	"ai_overview_cited" integer NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seo_domain_months_pkey" PRIMARY KEY ("tenant_id", "database", "month")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_backlink_months" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"month" date NOT NULL,
	"read_on" date NOT NULL,
	"authority_score" integer NOT NULL,
	"backlinks" bigint NOT NULL,
	"referring_domains" integer NOT NULL,
	-- Null for a month from Semrush's history, which reports only the totals.
	"follow_backlinks" bigint,
	"nofollow_backlinks" bigint,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seo_backlink_months_pkey" PRIMARY KEY ("tenant_id", "month")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_keywords" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"database" text NOT NULL,
	"month" date NOT NULL,
	-- 'top_organic': the domain's keywords by Semrush's traffic estimate.
	-- 'ai_overview': the keywords where the domain is cited in an AI Overview.
	"list" text NOT NULL CHECK ("list" IN ('top_organic', 'ai_overview')),
	"keyword" text NOT NULL,
	"position" integer NOT NULL,
	"previous_position" integer,
	"search_volume" integer NOT NULL,
	"cpc" numeric(10, 2),
	"url" text NOT NULL,
	-- Share of the domain's estimated organic traffic, as a percentage.
	"traffic_share" numeric(7, 2),
	"keyword_difficulty" numeric(5, 2),
	-- Semrush's codes, verbatim: intents '0'..'3', SERP features as numbers.
	"intents" text,
	"serp_features" text,
	"serp_features_held" text,
	"read_on" date NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	CONSTRAINT "seo_keywords_pkey" PRIMARY KEY ("tenant_id", "database", "month", "list", "keyword")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_competitors" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"database" text NOT NULL,
	"month" date NOT NULL,
	"domain" text NOT NULL,
	-- Semrush's competitor relevance, 0–1.
	"relevance" numeric(6, 4) NOT NULL,
	"common_keywords" integer NOT NULL,
	"organic_keywords" integer NOT NULL,
	"organic_traffic" integer NOT NULL,
	"organic_traffic_cost" numeric(14, 2) NOT NULL,
	"read_on" date NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	CONSTRAINT "seo_competitors_pkey" PRIMARY KEY ("tenant_id", "database", "month", "domain")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_referring_domain_changes" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"change" text NOT NULL CHECK ("change" IN ('new', 'lost')),
	"domain" text NOT NULL,
	"authority_score" integer NOT NULL,
	"backlinks" integer NOT NULL,
	-- Tenant-local days, from Semrush's epoch seconds at ingest.
	"first_seen" date NOT NULL,
	"last_seen" date NOT NULL,
	"read_on" date NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	CONSTRAINT "seo_referring_domain_changes_pkey" PRIMARY KEY ("tenant_id", "change", "domain")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_site_audits" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"project_id" bigint NOT NULL,
	"snapshot_id" text NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"finished_on" date NOT NULL,
	-- Semrush's Site Health, 0–100.
	"health_score" integer NOT NULL,
	"ai_search_score" integer,
	-- { crawlability: 97, https: 100, … } as Semrush names them.
	"thematic_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pages_crawled" integer NOT NULL,
	"pages_limit" integer NOT NULL,
	"errors" integer NOT NULL,
	"warnings" integer NOT NULL,
	"notices" integer NOT NULL,
	"read_on" date NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	CONSTRAINT "seo_site_audits_pkey" PRIMARY KEY ("tenant_id", "snapshot_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_site_audit_issues" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"snapshot_id" text NOT NULL,
	"issue_id" integer NOT NULL,
	"severity" text NOT NULL CHECK ("severity" IN ('error', 'warning', 'notice')),
	"title" text NOT NULL,
	-- Pages (or checks, for a site-wide issue) the crawl found it on.
	"count" integer NOT NULL,
	"delta" integer NOT NULL,
	CONSTRAINT "seo_site_audit_issues_pkey" PRIMARY KEY ("tenant_id", "snapshot_id", "issue_id"),
	CONSTRAINT "seo_site_audit_issues_snapshot_fk" FOREIGN KEY ("tenant_id", "snapshot_id")
	  REFERENCES "seo_site_audits"("tenant_id", "snapshot_id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_tracked_positions" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"campaign_id" text NOT NULL,
	"day" date NOT NULL,
	"keyword" text NOT NULL,
	-- Null where the domain was not in the top 100 that day. Not zero: zero is
	-- not a position.
	"position" integer,
	"url" text,
	"search_volume" integer,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	CONSTRAINT "seo_tracked_positions_pkey" PRIMARY KEY ("tenant_id", "campaign_id", "day", "keyword")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "seo_tracking_visibility" (
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"campaign_id" text NOT NULL,
	"day" date NOT NULL,
	-- Semrush's visibility index for the tracked keyword set, 0–100.
	"visibility" numeric(7, 3) NOT NULL,
	"sync_run_id" uuid REFERENCES "sync_runs"("id") ON DELETE SET NULL,
	CONSTRAINT "seo_tracking_visibility_pkey" PRIMARY KEY ("tenant_id", "campaign_id", "day")
);--> statement-breakpoint

DO $$
declare
  t text;
  tables text[] := array[
    'seo_report_reads', 'seo_domain_months', 'seo_backlink_months', 'seo_keywords',
    'seo_competitors', 'seo_referring_domain_changes', 'seo_site_audits',
    'seo_site_audit_issues', 'seo_tracked_positions', 'seo_tracking_visibility'
  ];
begin
  foreach t in array tables loop
    execute format('grant select on public.%I to zeeraa_app', t);
    execute format('grant select, insert, update on public.%I to zeeraa_jobs', t);
    execute format('grant select, insert, update, delete on public.%I to zeeraa_maintenance', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($f$
      create policy tenant_isolation on public.%I
        as permissive for select to zeeraa_app
        using (tenant_id = app.current_tenant_id() and app.has_tenant_access())
    $f$, t);
    execute format('drop policy if exists tenant_admin_write on public.%I', t);
    execute format($f$
      create policy tenant_admin_write on public.%I
        as permissive for all to zeeraa_app
        using (tenant_id = app.current_tenant_id() and app.has_tenant_access()
               and app.effective_role() = 'zeeraa_admin')
        with check (tenant_id = app.current_tenant_id() and app.has_tenant_access()
                    and app.effective_role() = 'zeeraa_admin')
    $f$, t);
    execute format('drop policy if exists job_tenant_isolation on public.%I', t);
    execute format($f$
      create policy job_tenant_isolation on public.%I
        as permissive for all to zeeraa_jobs
        using (tenant_id = app.current_tenant_id())
        with check (tenant_id = app.current_tenant_id())
    $f$, t);
    execute format('drop policy if exists maintenance_access on public.%I', t);
    execute format($f$
      create policy maintenance_access on public.%I
        as permissive for all to zeeraa_maintenance
        using (app.is_maintenance())
        with check (app.is_maintenance())
    $f$, t);
  end loop;
end $$;
