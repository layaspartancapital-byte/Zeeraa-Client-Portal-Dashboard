import { Inngest } from 'inngest';

/**
 * Ingestion runs on Inngest rather than on Vercel cron functions.
 *
 * Vercel functions have a hard timeout. Meta's Insights API is
 * submit-job-then-poll with waits measured in minutes, and a 90-day first
 * backfill across six platforms will exceed any of them — it passes in testing
 * on a small account and fails on real volume (§7). Inngest's durable steps
 * survive that; a serverless function does not.
 */
export const inngest = new Inngest({
  id: 'zeeraa-platform',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export type SyncRequested = { tenantId: string; connectionId: string; trigger?: string };
export type BackfillRequested = {
  tenantId: string;
  connectionId: string;
  since?: string;
  limit?: number;
};

/**
 * Exponential backoff, then a dead letter (§7).
 *
 * Failures here are usually the org rather than the network — a permission
 * revoked, a field renamed — so retrying forever would bury a configuration
 * problem under noise. Five attempts, then it stops and becomes visible on the
 * connection health screen.
 */
export const RETRIES = 4;
