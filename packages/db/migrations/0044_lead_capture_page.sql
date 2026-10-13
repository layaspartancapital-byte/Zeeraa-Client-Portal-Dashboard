-- ===========================================================================
-- The page a lead's form was submitted on.
--
-- Salesforce records it on the Lead (`acq_capture__c` in Spartan's org). The
-- website's Apply Now form writes utm_source=100A00 as its default on every
-- submission, which had read as an ad visit of unknown platform; the capture
-- page says which form it was, so a website lead with nothing paid about it
-- can be credited to SEO/Organic like a website referrer (`leadChannel`,
-- `organicCapturePages`, 13 October 2026).
--
-- Additive, so it runs before the deploy: the sync writes the column.
-- ===========================================================================

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "capture_url" text;
