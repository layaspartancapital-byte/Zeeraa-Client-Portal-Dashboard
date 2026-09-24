-- Organic search as a source, and whether a deal is closed (24 September 2026).
--
-- `referrer_url` is the page the lead arrived from (Salesforce
-- `referral_url__c` for Spartan, through the field mapping). `channel` is the
-- lead's source, resolved at ingest: the platform of its click where it has
-- one, `organic_search` where the `organic_search_evidence` config row's test
-- holds (a search-results referrer and no paid evidence at all), and null —
-- unattributed — otherwise. Lead-grain reports read `channel`, so the rule is
-- applied once rather than re-derived in every query.
--
-- `is_closed` is Salesforce's own `IsClosed`. A submission still marked
-- "Submitted" on a deal the CRM has closed is not waiting on anybody; the
-- lender simply never answered before the deal ended.
--
-- Nullable and additive on existing tenant-scoped tables: their policies
-- already cover them, and `zeeraa_jobs` holds UPDATE on both tables. Existing
-- rows fill from `backfill-lead-channel.ts` and the next re-pull.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "referrer_url" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "channel" text;
--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "is_closed" boolean;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_tenant_channel_idx" ON "leads" ("tenant_id", "channel");
