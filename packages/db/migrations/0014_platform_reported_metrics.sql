-- ===========================================================================
-- The figures each ad platform reports that we were discarding.
--
-- The platform pages show what an API actually returns and nothing else, so
-- every column here is **nullable, and null means "this platform does not
-- report it" rather than zero**. That distinction is the whole point: a CPM of
-- zero is a claim about an auction, and "Meta reports reach and Google does
-- not" is a claim about an API. Rendering the second as the first is the error
-- this schema is shaped to prevent.
--
--   * `campaigns.campaign_type` — the platform's own classification, stored
--     verbatim. Google's `advertising_channel_type` (SEARCH, VIDEO,
--     PERFORMANCE_MAX…) and Meta's `objective` (OUTCOME_LEADS, LINK_CLICKS…)
--     both land here. They are **not** a shared taxonomy and must never be
--     grouped across platforms: each page labels the column in its own
--     platform's word and maps its own values. One column because it is one
--     idea — "what kind of campaign does this platform think this is" — and
--     two columns would invite a join that means nothing.
--
--   * `daily_metrics.reach` — people, not impressions. Meta reports it; Google
--     does not. **It is not additive**: Meta deduplicates people across the
--     requested range, so summing daily reach counts somebody who saw an ad on
--     Monday and Tuesday twice. Stored at the grain it is reported at, and the
--     UI refuses to total it rather than quietly producing a number that is
--     always too high.
--
--   * `daily_metrics.clicks_all` — every click the platform counts, where it
--     distinguishes that from a click that goes somewhere. Meta reports both
--     (8,074 against 5,135 over Spartan's trailing 90 days); Google reports one
--     number and this stays null there. `clicks` remains the comparable one —
--     link clicks for Meta, clicks for Google — so the cross-channel table
--     keeps meaning one thing.
--
-- No new table, so no new policies. `campaigns` and `daily_metrics` already
-- carry tenant_isolation, maintenance_access, FORCE and the grants.
-- ===========================================================================

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "campaign_type" text;--> statement-breakpoint

ALTER TABLE "daily_metrics" ADD COLUMN IF NOT EXISTS "reach" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN IF NOT EXISTS "clicks_all" numeric(20, 0);--> statement-breakpoint

-- The platform pages group by type and read a date range for one platform.
CREATE INDEX IF NOT EXISTS "campaigns_tenant_platform_type_idx" ON "campaigns"
  USING btree ("tenant_id","platform","campaign_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "daily_metrics_tenant_platform_date_idx" ON "daily_metrics"
  USING btree ("tenant_id","platform","date");--> statement-breakpoint
