# Running state

Where the build actually is, so a fresh session does not have to reconstruct it
from commit history. Short by design: current phase, what is done, what is
blocked, what is next. Updated at the end of every session.

**Last updated: 17 September 2026.**

---

## Phase

Phase 3 — connectors and ingestion. Google Ads and Salesforce are both live.
The platform produces a real cost per funded deal; the number is thin, and why
is recorded below rather than hidden behind it.

## Done

- **Phases 1–2.** Schema, RLS (FORCE, membership-gated admin, mutation-tested),
  auth, tenant shell, Inngest jobs, Postgres writers, the MQL qualification bar,
  cold-outreach exclusion at ingest.
- **Google Ads, connected end to end.** `testConnection` healthy; the account
  reports `America/New_York` and so does the tenant, so no daily figure carries
  a boundary error.
- **90-day click backfill complete.** 2026-06-20 → 2026-09-17, 90 of 90 days,
  3,896 `ad_clicks`, every one resolving to a campaign. Captured on the last day
  2026-06-20 was reachable.
- **Campaigns and spend.** 43 campaigns, 401 `daily_metrics` rows,
  USD 78,873.97 over the window, 10 campaigns with spend.
- **Salesforce, synced.** 7,202 inbound leads (from 53,914 considered; 46,580
  excluded as out of scope, 132 unclassified), 712 opportunities, 1,759 stage
  events, 101 merges reconciled.
- **Click IDs recovered from converted Leads.** 243 of 243 converted leads
  carrying a `gclid` were walked to the opportunity they became, without the
  Opportunity-side field mapping existing. This is what makes any attribution
  possible today.

## The current cost per funded deal, and what is wrong with it

Over 2026-06-20 → 2026-09-17, both models agree (no deal has more than one
touch, so first and last touch resolve identically):

| | |
| --- | --- |
| Funded deals in window | 21 |
| Carrying a click ID | 9 |
| Resolving to a campaign | 6 |
| Click ID but no campaign (aged out of `click_view`) | 3 |
| No click ID at all | 12 |
| **Cost per funded deal (attributed)** | **USD 13,145.66** |
| All spend ÷ all funded deals | USD 3,755.90 |

The true figure is between those two and nearer the lower one. The attributed
number divides the whole window's spend by only the 6 deals that resolve to a
campaign, so it overstates by roughly the inverse of coverage. Do not quote it
to the client on its own — it is a well-attributed fraction of the truth, and
the coverage line is what makes it honest.

Coverage is 6 of 21 for two separate reasons, and only one is fixable:

1. **12 funded deals carry no click ID.** Their leads either predate click-ID
   capture or came through a path that never set `gclid`. Not recoverable.
2. **3 carry a click ID whose click aged out of `click_view`'s 90 days.** The
   deal funded inside the window; the click that produced it did not. Permanent,
   and the reason the backfill was run the day it was.

## Blocked

- **Opportunity-side click-ID fields still do not exist.** The converted-Lead
  route covers deals whose lead converted, which is why there is a number at
  all, but it cannot cover an opportunity created directly. See
  `docs/salesforce-fields.md` and `docs/salesforce-setup-checklist.md`.
- **`Opportunity.csbs__Decline_Reason__c` does not exist in the org.** The sync
  drops it from the query and reports it; decline reasons are unavailable until
  it is created. This is why the Salesforce sync reports `partial`.
- **MQL is undetermined for 6,843 of 7,202 leads.** The bar's two inputs are
  close to empty on inbound leads. `qualifyLead` returns null rather than
  guessing, and the stage renders as computed-and-undetermined.
- **Call tracking.** Vendor not selected.
- Microsoft Ads, Meta, LinkedIn Ads, GA4, Search Console, Semrush: not started.

## Next

1. Schedule the nightly syncs. Everything so far has been run by hand; the
   click ledger starts developing holes from 2026-09-18 if it is left.
2. Chase the Opportunity click-ID fields and the decline-reason field. Both are
   client-side and both are in the checklist.
3. Build the delivery view on top of this. The numbers exist now; what does not
   exist is the screen that renders coverage beside every one of them.

## Operational notes

All idempotent, all taking a tenant slug:

```bash
pnpm --filter @zeeraa/db   set-credentials  spartan google_ads   # or salesforce
pnpm --filter @zeeraa/jobs test-connection  spartan google_ads
pnpm --filter @zeeraa/jobs backfill-clicks  spartan [--days 90] [--max-days N]
pnpm --filter @zeeraa/jobs sync-google-ads  spartan [--days 90]
pnpm --filter @zeeraa/jobs sync-salesforce  spartan [--since YYYY-MM-DD] [--limit N]
pnpm --filter @zeeraa/jobs spend-to-funded  spartan [--days 90]
```

They read `DATABASE_URL_OWNER` and `DATABASE_URL_JOBS`; a local `.env` carrying
the documented defaults from `.env.example` is enough. Platform credentials come
from the shell and stop being environment variables at `set-credentials` — after
that they live encrypted in the connection row, per tenant.

`sync-salesforce` exits non-zero on `partial`, which today means only the
missing decline-reason field. Read the status line before treating it as a
failure.

The Google refresh token is a person's consent, not a service identity. It
breaks when the granting user loses account access, changes their password, or
removes the app, and surfaces as `waiting_on_client` rather than as a failure.
