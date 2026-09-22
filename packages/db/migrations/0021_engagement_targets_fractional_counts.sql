-- ===========================================================================
-- Contracted approvals and funded deals are fractions, not whole numbers.
--
-- 0020 typed both as `integer`, which was a reasonable guess and is wrong. The
-- engagement model — `SpartanCapital Google Ads Budget Projection for 8 Months`
-- — contracts:
--
--     M1   40.0 approvals    7.5 funded
--     M2   58.9 approvals   11.4 funded
--     M3   86.9 approvals   16.8 funded
--     ...
--     M8  603.8 approvals  116.9 funded
--
-- **These are projections, not counts of things.** Nobody funds half a deal;
-- the model is saying that at the contracted budget and the contracted cost per
-- funded deal, month one buys seven and a half of them. The halves matter,
-- because the model is internally consistent to them: CPA is budget over
-- approvals and CPF is budget over funded deals, and both reproduce the stated
-- figures only if the fractions survive.
--
-- Rounding at the door would have broken that quietly. M1 stores 8 instead of
-- 7.5, and $30,000 over 8 is $3,750 rather than the $4,000 the contract states
-- — a 6% error in the north-star target, arriving as a rounding decision nobody
-- made deliberately. Truncating to 7 errs 14% the other way.
--
-- `numeric(18, 2)`, matching the money columns beside them. Two decimal places
-- is what the model states and one more than it needs.
--
-- ---------------------------------------------------------------------------
-- This migration writes no rows, so it needs no `NO FORCE` bracket.
--
-- The rule in CLAUDE.md is about DML: an `UPDATE` or `DELETE` in a migration
-- matches nothing under FORCE and reports success. `ALTER COLUMN ... TYPE` is
-- DDL, runs as the table owner, and is not subject to row level security at
-- all. The widening is lossless — every existing value is an integer and every
-- integer is representable — so the rewrite cannot drop a row or a figure.
-- Verify with a row count and a null count either side regardless.
-- ===========================================================================

ALTER TABLE "engagement_targets"
  ALTER COLUMN "approvals" TYPE numeric(18, 2);--> statement-breakpoint

ALTER TABLE "engagement_targets"
  ALTER COLUMN "funded_deals" TYPE numeric(18, 2);--> statement-breakpoint
