-- ===========================================================================
-- A stage event taken from another stage's event (`stage_merges`).
--
-- Spartan's UW approval and offer are one step (25 September 2026): a deal is
-- approved at its approval or its offer, whichever came first. The offer is
-- still stored as itself — it is what Salesforce records, and the
-- reconciliation still checks it — and where an offer is a deal's first sign
-- of approval, an approval event is written at the offer's time with
-- `derived_from = 'offer'`. Null for every event read as itself.
--
-- The column is what lets the merge be recomputed from scratch on every sync
-- (delete where not null, derive again) and what lets the reconciliation call
-- those approvals explained rather than drift. Additive, no rows written;
-- runs before the deploy.
-- ===========================================================================

ALTER TABLE public.stage_events ADD COLUMN IF NOT EXISTS derived_from text;
