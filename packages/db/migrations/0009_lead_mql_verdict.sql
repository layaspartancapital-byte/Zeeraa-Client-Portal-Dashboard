-- ===========================================================================
-- The qualification verdict, stored as a verdict.
--
-- Spartan's MQL inputs are not numbers. Revenue and time in business arrive as
-- picklist labels and free text — `< $15,000`, `$10K - $25K`, `10-25k`,
-- `1 - 3 Years`, `New Business` — and 69% of inbound leads carry both in some
-- form while none carry both as a figure. Resolving a band gives an interval,
-- and comparing an interval to a threshold has three answers: entirely above,
-- entirely below, or containing it.
--
-- The tempting shortcut was to resolve each band to its lower bound and write
-- that into `self_reported_revenue`, because the bound reproduces the verdict
-- exactly for any resolvable band and needs no migration. It is the wrong
-- shortcut: that column means "what the merchant said they earn", anything
-- banding leads by revenue reads it, and a bound sitting there would be read as
-- a revenue figure by code that has no way to know otherwise. So the judgement
-- is stored and the bound is discarded.
--
-- No policy changes: `leads` already carries `tenant_isolation`,
-- `maintenance_access` and the job-role policies, and a column inherits them.
-- ===========================================================================
CREATE TYPE "public"."mql_verdict" AS ENUM('qualified', 'unqualified', 'undeterminable');--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "mql_verdict" "mql_verdict";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "mql_undeterminable_reason" text;
