-- A funnel stage can be measured at lead grain rather than opportunity grain.
--
-- Every stage so far has been counted from `stage_events`, which are keyed by
-- opportunity. That silently made the first stage of the funnel mean
-- "opportunity created" — for Spartan, 436 of them — while the column above it
-- read "Lead" and the CRM held 7,202 inbound leads. A reader has no way to see
-- that from the screen, and a first-stage count that is wrong by a factor of
-- sixteen discredits every rate computed from it.
--
-- The fix is not a special case for the word "lead". It is configuration: a
-- stage declares where it is counted from, and the engine reads that the same
-- way it already reads position and label. A tenant whose funnel starts at
-- Lead → Demo → Trial gets the same treatment with no code change.

ALTER TABLE funnel_stages
  ADD COLUMN source text NOT NULL DEFAULT 'stage_events';

ALTER TABLE funnel_stages
  ADD CONSTRAINT funnel_stages_source_check
  CHECK (source IN ('stage_events', 'leads'));

COMMENT ON COLUMN funnel_stages.source IS
  'Where this stage is counted from. ''stage_events'' is the default, keyed by '
  'opportunity. ''leads'' counts rows in `leads`, which is the inbound '
  'population — cold outreach is excluded at ingest — and is attributed by '
  '`leads.click_id_type` rather than through the attribution table, because a '
  'lead that never converted has no opportunity to attribute.';
