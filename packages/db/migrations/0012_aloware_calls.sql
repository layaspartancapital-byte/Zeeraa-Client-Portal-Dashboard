-- Call tracking, from Aloware directly.
--
-- Not from `Aloware_Call__c` in Salesforce. That object exists and holds 30,093
-- rows, but it is a copy whose completeness depends on the vendor's own
-- Salesforce integration — and a gap in that integration would be
-- indistinguishable here from a quiet day on the phones. A published metric
-- should not rest on a third party's sync of a third party.
--
-- `external_id` is Aloware's Communication ID and the upsert key. That is what
-- lets the historical CSV export and the live webhook coexist: a call
-- delivered twice, by two routes, lands on one row. Nothing appends.
--
-- Three outcomes, and `abandoned` is the one that must not be folded away — the
-- caller ended it before anybody answered, so it is neither a conversation nor
-- an agent's attempt at one (2,002 of 28,863 calls). `connected` additionally
-- requires talk time past a configured threshold rather than the vendor's
-- `completed` alone: 26,311 calls are completed, and 13,376 of those talked for
-- under ten seconds. Answering machines are not conversations.
--
-- PII. `contact_number` is a merchant's phone number and `agent_name` a real
-- person's. Both are tenant-scoped like everything else and neither is rendered
-- on any screen. The export also carries recordings, transcripts, contact names
-- and emails; none of it is ingested, because none of it is needed.

CREATE TYPE "public"."call_outcome" AS ENUM('connected', 'attempted', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('inbound', 'outbound', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."call_source" AS ENUM('csv_import', 'webhook');--> statement-breakpoint

-- The dialer knows nothing about a lead except the number it called, so the
-- number is the join. Normalised to ten digits at ingest, like dates.
ALTER TABLE "leads" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone_key" text;--> statement-breakpoint
CREATE INDEX "leads_tenant_phone_key_idx" ON "leads" USING btree ("tenant_id","phone_key");--> statement-breakpoint

CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"direction" "call_direction" NOT NULL,
	"outcome" "call_outcome" NOT NULL,
	"disposition" text,
	"answered_briefly" boolean DEFAULT false NOT NULL,
	"talk_time_seconds" numeric(10, 0),
	"duration_seconds" numeric(10, 0),
	"contact_number" text,
	"contact_key" text,
	"contact_external_id" text,
	"agent_name" text,
	"lead_external_id" text,
	"source" "call_source" NOT NULL,
	"sync_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_sync_run_id_sync_runs_id_fk"
  FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "calls_upsert_key" ON "calls" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "calls_tenant_occurred_idx" ON "calls" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "calls_tenant_contact_idx" ON "calls" USING btree ("tenant_id","contact_key");--> statement-breakpoint
CREATE INDEX "calls_tenant_lead_idx" ON "calls" USING btree ("tenant_id","lead_external_id","direction");--> statement-breakpoint
CREATE INDEX "calls_tenant_outcome_idx" ON "calls" USING btree ("tenant_id","outcome","occurred_at");--> statement-breakpoint

-- Hand-written from here down, so the exact USING/WITH CHECK clauses are
-- reviewable in this diff. Same treatment every tenant-scoped table gets.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.calls TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calls TO zeeraa_maintenance;--> statement-breakpoint
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.calls
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint
CREATE POLICY maintenance_access ON public.calls
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance()) WITH CHECK (app.is_maintenance());--> statement-breakpoint

-- Ingestion writes these: the CSV import, the webhook, and the pass that
-- resolves a call to a lead. Scoped to one tenant with no user, as every sync
-- is.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calls TO zeeraa_jobs;--> statement-breakpoint
CREATE POLICY job_tenant_isolation ON public.calls
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
