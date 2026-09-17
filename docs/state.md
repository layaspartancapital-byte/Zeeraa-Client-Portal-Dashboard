# Running state

Where the build actually is, so a fresh session does not have to reconstruct it
from commit history. Short by design: current phase, what is done, what is
blocked, what is next. Updated at the end of every session.

**Last updated: 17 September 2026.**

---

## Phase

Phase 3 — connectors and ingestion. Google Ads is live end to end. Salesforce is
blocked on the client's org configuration and has been since phase 2.

## Done

- **Phases 1–2.** Schema, RLS (FORCE, membership-gated admin, mutation-tested),
  auth, tenant shell, Inngest jobs, Postgres writers, the MQL qualification bar,
  cold-outreach exclusion at ingest.
- **Google Ads, fully connected (17 September 2026).** Credentials encrypted
  into the Spartan connection row; `testConnection` returns `healthy`; the
  account's reporting zone is `America/New_York` and matches the tenant's, so
  there is no day-boundary error on any daily figure.
- **90-day click backfill complete.** 2026-06-20 → 2026-09-17, 90 of 90 days,
  3,896 `ad_clicks` rows, every one resolving to a campaign. Captured on the
  last day 2026-06-20 was reachable.
- **Campaigns and daily spend.** 43 campaigns, 401 `daily_metrics` rows over 90
  days, USD 78,873.97 total spend, 10 campaigns with spend in the window.

## Blocked

- **Salesforce — the whole CRM half of the platform.** No credentials configured
  and the org work is outstanding: click-ID fields do not survive Lead →
  Opportunity conversion, so `gclid` never reaches the opportunity that funds.
  See `docs/salesforce-fields.md` and `docs/salesforce-setup-checklist.md`.
  Consequence: `leads`, `opportunities`, `stage_events` and
  `opportunity_click_ids` are all empty, and **cost per funded deal has no
  denominator** — the join runs and correctly returns no value rather than a
  number.
- **Call tracking.** Vendor not selected. No connector can be configured.
- Microsoft Ads, Meta, LinkedIn Ads, GA4, Search Console, Semrush:
  `not_configured`, not yet started.

## Next

1. Salesforce org configuration, then a Salesforce backfill. That is the only
   thing standing between the platform and a real cost per funded deal — the ads
   half is complete and waiting.
2. Re-run `spend-to-funded` the moment CRM data lands. The click history it
   needs is already captured and would otherwise have aged out.
3. Schedule the nightly Google Ads sync. The backfill was run by hand; nothing
   is yet re-pulling the trailing window on a schedule, so the click ledger will
   start developing holes from 2026-09-18 onward if this is left.

## Operational notes

Scripts added this session, all idempotent and all taking a tenant slug:

```bash
pnpm --filter @zeeraa/db   set-credentials  spartan google_ads
pnpm --filter @zeeraa/jobs test-connection  spartan google_ads
pnpm --filter @zeeraa/jobs backfill-clicks  spartan [--days 90] [--max-days N]
pnpm --filter @zeeraa/jobs sync-google-ads  spartan [--days 90]
pnpm --filter @zeeraa/jobs spend-to-funded  spartan [--days 90]
```

They read `DATABASE_URL_OWNER` and `DATABASE_URL_JOBS`; a local `.env` carrying
the documented defaults from `.env.example` is enough. Google Ads credentials
come from the shell (`GOOGLE_ADS_CLIENT_ID`, `_CLIENT_SECRET`, `_REFRESH_TOKEN`)
and stop being environment variables at `set-credentials` — after that they live
encrypted in the connection row, per tenant.

The refresh token is a person's consent, not a service identity. It breaks when
the granting user loses account access, changes their password, or removes the
app. That surfaces as `waiting_on_client`, not as a failure.
