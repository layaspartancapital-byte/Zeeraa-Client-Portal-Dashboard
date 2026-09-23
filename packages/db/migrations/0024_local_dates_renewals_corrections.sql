-- ===========================================================================
-- Tenant-local dates, renewal exclusion and hand-recorded stage corrections.
--
-- Three things the 23 September 2026 funded-deal audit found, in one migration
-- because all three are columns on the same tables and none is useful alone.
--
-- 1. **A local date beside every instant a report buckets.** Stage events,
--    leads, calls and submissions were bucketed by `to_char(instant)` on a UTC
--    session, so a deal funded at 9pm Eastern on the 31st landed in the next
--    month, and every call after 8pm Eastern landed on the next day. The
--    convention is that dates are normalised into the tenant timezone *at
--    ingest*, never at query time — `daily_metrics.date` already is — so each
--    table gets a `date` column written by its writer from `tenants.timezone`,
--    and reports bucket and filter on that.
--
-- 2. **`stage_events.excluded_reason`**, set at ingest where a configured rule
--    says an event is real but must not be counted — renewal deals reaching
--    Funded, which are not marketing's. Null means counted. The row is kept
--    rather than skipped so the exclusion is a query away from being audited.
--    `opportunities.deal_type` stores the raw CRM value the rule reads.
--
-- 3. **`corrected`, a third stage origin, and a precision.** A funded date the
--    CRM records wrongly and a person has corrected is neither observed nor
--    computed. `occurred_precision = 'month'` says the day is not known, so
--    nothing may compute a duration from it; `correction_source` says who said
--    so and on what evidence.
--
-- Also `engagement_targets.funded_amount`, the model's Funded Amount column,
-- which had no column to load into.
--
-- **The backfill is bracketed by NO FORCE / FORCE on every table it touches,
-- including `tenants`**, which it only reads. The owner role migrations run as
-- holds no policy on a FORCE'd table, so without the bracket the join to
-- `tenants` sees no rows and every UPDATE reports success having changed
-- nothing — `0016` is the worked example. The DO block at the end refuses the
-- migration if any row was left without its date. `ALTER TABLE` takes ACCESS
-- EXCLUSIVE, so no session sees a table unforced.
--
-- The date columns stay nullable here. Code deployed before this migration
-- does not write them, and NOT NULL would make its next sync fail; tightening
-- them is a later migration, after the deploy that writes them.
--
-- Additive, so it runs before the deploy.
-- ===========================================================================

ALTER TYPE public.stage_origin ADD VALUE IF NOT EXISTS 'corrected';--> statement-breakpoint

ALTER TABLE public.stage_events
  ADD COLUMN IF NOT EXISTS occurred_on date,
  ADD COLUMN IF NOT EXISTS occurred_precision text NOT NULL DEFAULT 'instant',
  ADD COLUMN IF NOT EXISTS excluded_reason text,
  ADD COLUMN IF NOT EXISTS correction_source text;--> statement-breakpoint
ALTER TABLE public.stage_events
  ADD CONSTRAINT stage_events_precision_check
  CHECK (occurred_precision IN ('instant', 'month'));--> statement-breakpoint
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS created_on date;--> statement-breakpoint
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS occurred_on date;--> statement-breakpoint
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS submitted_on date;--> statement-breakpoint
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS deal_type text;--> statement-breakpoint
ALTER TABLE public.engagement_targets
  ADD COLUMN IF NOT EXISTS funded_amount numeric(18, 2);--> statement-breakpoint

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

DO $$
declare
  missing bigint;
begin
  select (select count(*) from public.stage_events where occurred_on is null)
       + (select count(*) from public.leads where created_on is null)
       + (select count(*) from public.calls where occurred_on is null)
       + (select count(*) from public.submissions where submitted_on is null)
    into missing;
  if missing > 0 then
    raise exception 'local-date backfill left % rows without a date; the NO FORCE bracket did not take', missing;
  end if;
end $$;--> statement-breakpoint

ALTER TABLE public.submissions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.leads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stage_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stage_events_tenant_stage_on_idx
  ON public.stage_events (tenant_id, stage, occurred_on);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leads_tenant_created_on_idx
  ON public.leads (tenant_id, created_on);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS calls_tenant_occurred_on_idx
  ON public.calls (tenant_id, occurred_on);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS submissions_tenant_submitted_on_idx
  ON public.submissions (tenant_id, submitted_on);
