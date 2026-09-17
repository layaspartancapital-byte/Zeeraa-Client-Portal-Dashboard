CREATE TABLE "blocked_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"label" text NOT NULL,
	"reason" text NOT NULL,
	"needed" text,
	"evidence" text,
	"blocked_since" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "exclusions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "blocked_dependencies" ADD CONSTRAINT "blocked_dependencies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_dependencies_tenant_key_key" ON "blocked_dependencies" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "blocked_dependencies_tenant_subject_idx" ON "blocked_dependencies" USING btree ("tenant_id","subject_kind","subject_key");--> statement-breakpoint

-- Hand-written from here down: the CHECK constraint and the RLS policies, so
-- the exact USING/WITH CHECK clauses are reviewable in this diff.

ALTER TABLE "blocked_dependencies" ADD CONSTRAINT "blocked_dependencies_subject_kind_check"
  CHECK ("subject_kind" IN ('funnel_stage', 'breakdown', 'metric'));--> statement-breakpoint

-- The same treatment every other tenant-scoped table gets.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocked_dependencies TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocked_dependencies TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.blocked_dependencies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.blocked_dependencies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.blocked_dependencies
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.blocked_dependencies
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint

-- A blocked dependency is written by a seed or an operator, never by a sync,
-- so jobs get read only.
GRANT SELECT ON public.blocked_dependencies TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_read_blocked_dependencies ON public.blocked_dependencies
  AS PERMISSIVE FOR SELECT TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id());
