-- ===========================================================================
-- The tenant-local dates become required, and leads can be excluded too.
--
-- The contract half of 0024. 0024 added `occurred_on`, `created_on` and
-- `submitted_on` nullable, because the code deployed at the time did not write
-- them and a NOT NULL would have failed its next sync. That code is replaced
-- (deploy of fc16ae2, 23 September 2026), so every writer now fills them.
--
-- **Rows written in the gap are dated first.** Between 0024 and the deploy the
-- old code went on writing — 14 webhook calls arrived undated — and a report
-- filtering on the date would never count them. They are backfilled here from
-- `tenants.timezone`, inside the same NO FORCE / FORCE bracket 0024 used, and
-- for the same reason: the owner role holds no policy on a FORCE'd table, so a
-- bare UPDATE matches nothing and reports success. Then NOT NULL, which is the
-- check that the backfill landed — it fails the migration if a row is missed.
--
-- **`leads.excluded_reason`**, for the same rule `stage_events` already has.
-- Renewal-type deals are not marketing's at any stage (client decision, 23
-- September 2026), and two leads converted into renewals: counted from
-- `leads`, they would still sit in Lead and MQL. Null means counted.
--
-- Run after the deploy, never before it.
-- ===========================================================================

ALTER TABLE public.tenants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stage_events NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.leads NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calls NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.submissions NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

UPDATE public.stage_events se
   SET occurred_on = (se.occurred_at AT TIME ZONE t.timezone)::date
  FROM public.tenants t
 WHERE t.id = se.tenant_id AND se.occurred_on IS NULL;--> statement-breakpoint
UPDATE public.leads l
   SET created_on = (l.created_at AT TIME ZONE t.timezone)::date
  FROM public.tenants t
 WHERE t.id = l.tenant_id AND l.created_on IS NULL;--> statement-breakpoint
UPDATE public.calls c
   SET occurred_on = (c.occurred_at AT TIME ZONE t.timezone)::date
  FROM public.tenants t
 WHERE t.id = c.tenant_id AND c.occurred_on IS NULL;--> statement-breakpoint
UPDATE public.submissions s
   SET submitted_on = (s.submitted_at AT TIME ZONE t.timezone)::date
  FROM public.tenants t
 WHERE t.id = s.tenant_id AND s.submitted_on IS NULL;--> statement-breakpoint

ALTER TABLE public.stage_events ALTER COLUMN occurred_on SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.leads ALTER COLUMN created_on SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.calls ALTER COLUMN occurred_on SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.submissions ALTER COLUMN submitted_on SET NOT NULL;--> statement-breakpoint

ALTER TABLE public.submissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.leads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stage_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS excluded_reason text;
