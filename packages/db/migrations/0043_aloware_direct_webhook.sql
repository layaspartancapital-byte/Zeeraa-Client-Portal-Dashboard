-- ===========================================================================
-- Aloware's own webhook, run beside the Zap until it can replace it.
--
-- Zapier is running out of tasks, and Aloware can post the same "call
-- disposed" event directly. On 24 September its direct posts reached this
-- endpoint and were refused as unauthenticated, and nothing recorded what they
-- had sent — so there was nothing to fix the match against. Three additions:
--
--   * `webhook_deliveries.senders` and `.samples`: the day's counts per
--     sender, and the latest redacted description of a post per sender and
--     outcome (header names, the credential's shape, field paths; no personal
--     value). Both bounded inside the existing one-row-per-day bucket.
--   * `calls.agent_external_id`: the native payload carries the agent's
--     Aloware user id and no name; the name is resolved from config, and a map
--     completed later can still be applied to calls already stored.
--   * `call_deliveries`: each sender's copy of each call. `calls` keeps one
--     row per Communication ID, which is the dedupe — and exactly why it
--     cannot say whether the two copies agreed. This can, and the comparison
--     is what says when the Zap can be turned off.
--
-- Additive, so it runs before the deploy.
-- ===========================================================================

ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "senders" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "samples" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "agent_external_id" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "call_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"direction" text NOT NULL,
	"outcome" text NOT NULL,
	"disposition" text,
	"talk_time_seconds" numeric(10, 0),
	"duration_seconds" numeric(10, 0),
	-- A merchant's number, keyed. PII exactly as `calls.contact_key` is.
	"contact_key" text,
	"agent_name" text,
	"agent_external_id" text,
	-- Whether this copy was written to `calls` or only recorded (shadow mode).
	"written" boolean DEFAULT false NOT NULL,
	"deliveries" integer DEFAULT 1 NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_deliveries_sender_known" CHECK ("sender" IN ('aloware', 'zapier', 'unknown'))
);
--> statement-breakpoint

ALTER TABLE "call_deliveries"
  ADD CONSTRAINT "call_deliveries_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One copy per sender per call: a re-delivery updates it. Bounded by the
-- number of calls, which only an authenticated sender can create.
CREATE UNIQUE INDEX IF NOT EXISTS "call_deliveries_tenant_sender_call_key"
  ON "call_deliveries" USING btree ("tenant_id","sender","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_deliveries_tenant_received_idx"
  ON "call_deliveries" USING btree ("tenant_id","first_received_at");--> statement-breakpoint

-- --------------------------------------------------------------------------
-- The standard policy set (see 0028). `zeeraa_jobs` writes, because a
-- delivery is ingestion; the application only reads. No DELETE for jobs: a
-- copy that was delivered is a fact, and the comparison depends on it.
-- --------------------------------------------------------------------------
GRANT SELECT ON public.call_deliveries TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.call_deliveries TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.call_deliveries TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.call_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.call_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.call_deliveries
  AS PERMISSIVE FOR SELECT TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

CREATE POLICY tenant_admin_write ON public.call_deliveries
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
         AND app.effective_role() = 'zeeraa_admin')
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access()
              AND app.effective_role() = 'zeeraa_admin');--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.call_deliveries
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.call_deliveries
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());
