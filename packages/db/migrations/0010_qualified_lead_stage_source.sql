-- A stage can be counted from the leads that pass the qualification bar.
--
-- MQL was counted from `stage_events`, and an MQL event is stamped against an
-- opportunity. So the stage counted the qualified leads that went on to
-- convert — 26 of 649 over Spartan's trailing 90 days — while the label said
-- MQL and the rate above it divided that by every inbound lead, reporting a
-- qualification rate of 0.7% against a measured 17.0%.
--
-- A qualified lead is a judgement about a *lead*, so it has to be counted at
-- lead grain. `qualified_leads` is the `leads` population narrowed to
-- `mql_verdict = 'qualified'`: the same source of record, one predicate. It is
-- a third value here rather than a filter expressed in code, for the same
-- reason `leads` was — a tenant whose second stage is a different judgement
-- declares it, and no client-specific branch appears anywhere.
--
-- Note what this does *not* make true: applications are still not drawn from
-- MQLs. The bar is computed from self-reported fields after the fact rather
-- than being a gate a lead passes through, so a lead that misses it can still
-- apply, and MQL → Application renders no rate. See docs/brief-amendments.md.

ALTER TABLE funnel_stages
  DROP CONSTRAINT IF EXISTS funnel_stages_source_check;

ALTER TABLE funnel_stages
  ADD CONSTRAINT funnel_stages_source_check
  CHECK (source IN ('stage_events', 'leads', 'qualified_leads'));

COMMENT ON COLUMN funnel_stages.source IS
  'Where this stage is counted from. ''stage_events'' is the default, keyed by '
  'opportunity. ''leads'' counts rows in `leads`, which is the inbound '
  'population — cold outreach is excluded at ingest — and is attributed by '
  '`leads.click_id_type` rather than through the attribution table, because a '
  'lead that never converted has no opportunity to attribute. '
  '''qualified_leads'' is that population narrowed to `mql_verdict = '
  '''''qualified''''`, for a stage that is a judgement about a lead rather '
  'than an event in a CRM.';
