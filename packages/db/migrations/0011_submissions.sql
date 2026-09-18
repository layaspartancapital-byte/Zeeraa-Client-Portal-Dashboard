-- Lender-grain submissions.
--
-- The platform has been reading approve, offer and decline off the opportunity,
-- which is one level above where they happen. A deal is submitted to several
-- lenders at once — Spartan's median is four, its maximum ten — and each lender
-- answers separately. Flattening those answers onto the deal is what produced a
-- deal-level offer rate of 58.8% where the lender-grain figure is 18.2%, and it
-- is why "which lender declines this profile" could not be asked at all.
--
-- One table, and the lender denormalised onto it. The lender is an Account in
-- the CRM and this platform has no reason to ingest 25,358 Accounts to label
-- six of them, so the name travels with the submission. It is a dimension, not
-- an entity we own.
--
-- Decline reasons are an array because the source is a multipicklist: one
-- lender can cite several reasons for one decline. That makes a reason
-- breakdown a count of citations, never a share of deals, and the array keeps
-- that visible rather than letting a join quietly imply otherwise.

CREATE TYPE "public"."submission_outcome" AS ENUM('offered', 'declined', 'undecided');--> statement-breakpoint

CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"opportunity_external_id" text NOT NULL,
	"lender_external_id" text,
	"lender_name" text,
	"status" text,
	"outcome" "submission_outcome" NOT NULL,
	"undecided_reason" text,
	"decline_reasons" text[],
	"submitted_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "submissions" ADD CONSTRAINT "submissions_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_sync_run_id_sync_runs_id_fk"
  FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "submissions_upsert_key" ON "submissions" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "submissions_tenant_opportunity_idx" ON "submissions" USING btree ("tenant_id","opportunity_external_id");--> statement-breakpoint
CREATE INDEX "submissions_tenant_outcome_idx" ON "submissions" USING btree ("tenant_id","outcome","submitted_at");--> statement-breakpoint
CREATE INDEX "submissions_tenant_lender_idx" ON "submissions" USING btree ("tenant_id","lender_external_id","outcome");--> statement-breakpoint

-- Hand-written from here down, so the exact USING/WITH CHECK clauses are
-- reviewable in this diff. Same treatment every tenant-scoped table gets.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.submissions TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.submissions TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.submissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.submissions
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.submissions
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint

-- Ingestion writes these, scoped to one tenant with no user, as every sync is.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.submissions TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.submissions
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
