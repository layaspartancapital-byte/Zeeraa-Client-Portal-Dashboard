-- The rest of a lead's source evidence (24 September 2026).
--
-- `lead_source` is the CRM's Lead Source picklist, verbatim: it names Meta's
-- own lead forms (no fbclid), lead vendors, and outbound lists. `braid` is a
-- gbraid or wbraid, Google's click ID for iOS traffic where no gclid is sent.
-- Both feed `leadChannel` in core through the `lead_source_rules` config row;
-- `leads.channel` (0035) stores the answer.
--
-- Nullable and additive on a tenant-scoped table whose policies already cover
-- it; existing rows fill from `backfill-lead-channel.ts`.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lead_source" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "braid" text;
