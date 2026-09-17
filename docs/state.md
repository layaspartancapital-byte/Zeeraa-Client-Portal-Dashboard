# Running state

Where the build actually is, so a fresh session does not have to reconstruct it
from commit history. Short by design: current phase, what is done, what is
blocked, what is next. Updated at the end of every session.

**Last updated: 17 September 2026.**

---

## Phase

Phase 4 — screens. Phase 3 (connectors and ingestion) is complete: Google Ads
and Salesforce are both live and the platform produces a real cost per funded
deal. The executive view and the monthly performance table now render it from
live data. The funnel, delivery and workspace screens are still phase-1 stubs.

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

## Cost per funded deal — Google Ads, trailing 90 days

Both models agree; no deal has more than one touch yet, so first and last touch
cannot diverge.

| | |
| --- | --- |
| Channel spend (Google Ads) | USD 78,873.97 |
| **Deals attributed to Google Ads** | **9** |
| — of those, campaign known | 6 |
| — click aged out of `click_view`, channel still known | 3 |
| **Cost per funded deal (Google Ads)** | **USD 8,763.77** |
| Plausible range | USD 3,755.90 – USD 8,763.77 |
| Deals attributed to another channel | 0 |
| Deals attributed to nobody | 12 |
| (Context only) deals funded in period, all sources | 21 |

The 12 unattributed deals are **not** in the denominator and must never be. They
came from organic, referral, sales outbound and repeat business as well as
possibly from paid media, and nothing in the data says which. The range is what
they could do to the figure if every one of them turned out to be Google Ads —
the most generous reading available, not an estimate. See
`docs/brief-amendments.md`, "§8 — `cost_per_funded_deal` is a channel metric".

Coverage is limited by two things and only one is fixable:

1. **12 funded deals carry no click ID.** Leads that predate click-ID capture,
   or that arrived through a path that never set `gclid`. Not recoverable.
2. **3 carry a click ID whose click aged out of the 90-day window.** These still
   count for the channel — a `gclid` is a Google Ads click — but cannot be
   placed on a campaign. Permanent, and the reason the backfill ran when it did.

**Blended cost per funded deal is not computed.** It is a different metric with
a different denominator (total marketing spend over total marketing-sourced
deals) and needs every channel ingested before it means anything. With only
Google Ads live, a blended figure would be the Google Ads figure wearing a
broader name.

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

## Phase 4 progress

Done:

- **The separation rule is in the UI, not only the arithmetic.** Channel and
  unattributed figures are different TypeScript shapes, so a component cannot
  put them on one row by iterating a list. `UnattributedRow` has no `spend` and
  no `costPerDeal` fields at all. See `docs/brief-amendments.md`, "§9.2 and §12".
- **`CostPerDealFigure` takes a `ChannelCostPerDeal` and has no prop that
  accepts a number**, so a bare cost-per-deal figure is not something a
  developer can render by forgetting something. Coverage and range are on the
  same ground as the value, above the fold.
- **Executive view** renders one channel's cost per funded deal, named as one
  channel's, and states on the band itself that the blended figure is absent and
  why.
- **Monthly performance table** — channels, an explicit unattributed row that is
  not a channel, and a totals row whose cost-per-deal cell is a stated absence.
  Blocked stages render their dependency, never a zero; computed stages are
  marked computed.

Next, in order:

1. **Funnel view.** Still a phase-1 stub for everything but the stage flow. It
   needs the channel filter built on `channelReach`, so a channel's offer rate
   is offers attributed to it over leads attributed to it.
2. **Charts on the performance screen.** Four, reading the same query as the
   table. Cost per funded deal by channel must carry its range as an interval,
   not a bar.
3. **Delivery view**, then the workspace.
4. **Schedule the nightly syncs.** Everything so far has been run by hand; the
   click ledger starts developing holes from 2026-09-18 if this is left. This is
   now the most time-sensitive item on the list.
5. Chase the Opportunity click-ID fields and the decline-reason field.

## Open question, raised 17 September 2026

The funnel's `lead` stage is configured as `opportunity_created`, so the Lead
column counts 436 opportunities rather than the 7,202 inbound leads Salesforce
holds. It renders marked "computed", which helps, but a client reading
"Lead: 436" beside a lead-generation engagement will read it as lead volume.
Either the stage wants renaming, or the funnel wants a real lead stage beneath
it. A configuration decision, not a code one.

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
