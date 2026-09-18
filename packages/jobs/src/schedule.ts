/**
 * The sync schedule (§7).
 *
 * Declared here as data: what runs, how often, and what window it re-pulls.
 *
 * **Routine syncing runs on Vercel Cron**, hourly, through
 * `/api/cron/sync` → `runIncrementalSync`. It is sized for a 60-second
 * function: two days of paid media, and Salesforce since its last completed
 * read.
 *
 * The backfill does not run there and cannot. Ninety days of `click_view` is
 * ninety sequential requests, and Meta's Insights API is submit-job-then-poll
 * with waits measured in minutes — both exceed any serverless timeout, which is
 * the reason §7 specified durable steps in the first place. That reasoning still
 * holds for the backfill; it is `scripts/run-scheduled.ts` and the per-platform
 * scripts, run from a machine with no request timeout. See
 * `docs/brief-amendments.md`.
 */
export type JobSchedule = {
  id: string;
  cadence: string;
  description: string;
  /** Trailing window re-pulled on each run, in days. Null where not windowed. */
  windowDays: number | null;
};

export const SCHEDULE: JobSchedule[] = [
  {
    id: 'salesforce.incremental',
    cadence: 'hourly',
    description: 'Salesforce incremental sync on SystemModstamp.',
    windowDays: null,
  },
  {
    id: 'ads.nightly',
    cadence: '0 3 * * * (America/New_York)',
    description:
      'All ad platforms, trailing 90 days, upserted. The re-pull is deliberate: ' +
      'Google and Meta backfill conversions for 30+ days and CRM records change ' +
      'stage retroactively, so re-pulling and upserting makes restatements ' +
      'self-correct. Appending would double-count every one of them.',
    windowDays: 90,
  },
  {
    id: 'organic.weekly',
    cadence: 'weekly',
    description: 'Search Console, Semrush rankings and backlinks, AI-visibility prompt sweep.',
    windowDays: null,
  },
  {
    id: 'notifications.dispatch',
    cadence: 'every 5 minutes',
    description: 'Drains the notification queue across in-app, email and Slack.',
    windowDays: null,
  },
  {
    id: 'notifications.digest',
    cadence: '0 8 * * * (America/New_York)',
    description: 'Unread digest email for anyone whose preference is digest.',
    windowDays: null,
  },
  {
    id: 'sync.manual',
    cadence: 'on demand',
    description: 'Per-tenant "Sync now", available to zeeraa_admin.',
    windowDays: 90,
  },
];

/** Exponential backoff with a dead letter after repeated failure (§7). */
export const RETRY_POLICY = {
  attempts: 5,
  backoff: 'exponential',
  initialDelaySeconds: 30,
  deadLetterAfterAttempts: 5,
} as const;
