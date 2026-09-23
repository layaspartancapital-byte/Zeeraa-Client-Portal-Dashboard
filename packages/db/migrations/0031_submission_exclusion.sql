-- ===========================================================================
-- A submission can be real and not counted, like a stage event.
--
-- The client decided on 23 September 2026 that renewals, add-ons and win-backs
-- are excluded from every funnel stage, every rate and every cost. Stage
-- events and leads carry `excluded_reason` for it; submissions did not, so the
-- lender offer rate, the per-lender rates and the decline reasons still counted
-- renewal submissions (two in July 2026). Set by the same tenant-wide
-- recompute that excludes the stage events (`applyStageExclusions`), filtered
-- by `submissionsIn`.
--
-- DDL only: no rows are written here, so no FORCE bracket is needed. The
-- column fills on the next Salesforce sync.
-- ===========================================================================

ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "excluded_reason" text;
