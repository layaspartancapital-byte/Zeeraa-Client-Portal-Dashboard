-- ===========================================================================
-- What reached a webhook endpoint, whether or not anything came of it.
--
-- A pushed source has no sync run to fail, so its silence has no shape. The
-- Aloware endpoint had two independent reader bugs in four days — the CSV's
-- field names, then an allow-list on an event name that never arrives — and
-- **neither was visible from the database**, because a rejected delivery
-- returns 200, counts its reasons into the response body and discards them.
-- Nothing distinguished "Aloware has never called us" from "Aloware calls us
-- 300 times a day and we refuse every one".
--
-- This table is that distinction, and nothing more.
--
-- **A day bucket per tenant per source, not a row per delivery.** The endpoint
-- is public, so a row per POST is a stranger's way of growing this table
-- without limit. A counter that a delivery increments is bounded at one row per
-- tenant per source per day however hard anybody pushes on it, and it answers
-- the question just as well: nobody needs the 300 rows, they need to know there
-- were 300 and why 300 were refused.
--
-- `day` is the tenant's local day, like every other date here — normalised at
-- ingest and never at query time.
--
-- Additive, so it runs before the deploy.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	-- The connector key, as `sync_runs.platform` writes it: `aloware`. Not the
	-- call source, because the next pushed source will not be calls.
	"source" text NOT NULL,
	"day" date NOT NULL,
	-- Requests that reached the handler for this tenant, including the ones
	-- refused before the body was read. This is the count that answers "has
	-- anything ever arrived", and it is the whole point of the table.
	"received" integer DEFAULT 0 NOT NULL,
	-- Rows upserted, and records the reader refused. Records, not requests: one
	-- POST may carry a batch.
	"accepted" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	-- reason -> count, mixing the two grains on purpose. A request refused
	-- before parsing has no records to count, and `unauthenticated: 40` is the
	-- most actionable line this table can carry. The writer caps the number of
	-- distinct keys, because a rejection reason quotes the value that caused it
	-- and a vendor sending junk would otherwise grow one row without limit.
	"reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_counts_non_negative"
	  CHECK ("received" >= 0 AND "accepted" >= 0 AND "rejected" >= 0)
);
--> statement-breakpoint

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The upsert key. One bucket per tenant per source per day, which is what
-- bounds the table.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_tenant_source_day_key"
  ON "webhook_deliveries" USING btree ("tenant_id","source","day");--> statement-breakpoint

-- --------------------------------------------------------------------------
-- Grants and policies, in the shape every tenant-scoped table here carries.
--
-- `zeeraa_jobs` writes: a delivery is ingestion, scoped to one tenant with no
-- user, exactly as a sync is. `zeeraa_app` reads it onto the data-quality card.
-- --------------------------------------------------------------------------
GRANT SELECT ON public.webhook_deliveries TO zeeraa_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_deliveries TO zeeraa_jobs;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_deliveries TO zeeraa_maintenance;--> statement-breakpoint

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.webhook_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read-only for the application by the column grant above; the policy is the
-- ordinary one, because row level security cannot restrict a column and the
-- grant is what does it. A screen has no reason to write a delivery record.
CREATE POLICY tenant_isolation ON public.webhook_deliveries
  AS PERMISSIVE FOR ALL TO zeeraa_app
  USING (tenant_id = app.current_tenant_id() AND app.has_tenant_access())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.has_tenant_access());--> statement-breakpoint

CREATE POLICY job_tenant_isolation ON public.webhook_deliveries
  AS PERMISSIVE FOR ALL TO zeeraa_jobs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY maintenance_access ON public.webhook_deliveries
  AS PERMISSIVE FOR ALL TO zeeraa_maintenance
  USING (app.is_maintenance())
  WITH CHECK (app.is_maintenance());--> statement-breakpoint
