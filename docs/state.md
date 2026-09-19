# Running state

Where the build actually is, so a fresh session does not have to reconstruct it
from commit history. Short by design: current phase, what is done, what is
blocked, what is next. Updated at the end of every session.

**Last updated: 19 September 2026, end of session.**

---

## Phase

Phase 4 — screens. Phase 3 (connectors and ingestion) is complete: Google Ads
and Salesforce are both live and the platform produces a real cost per funded
deal.

**Every screen was rebuilt on 18 September 2026 against design spec v2**, which
replaces §12 of the brief in full. §12 called for a hairline-and-whitespace
ledger; the client rejected the result as too plain and too text-heavy and
issued a modern SaaS analytics direction instead — left sidebar, elevated cards
on a grey-blue canvas, one blue, Inter, a mini chart on every KPI, green and red
deltas, no explanatory prose anywhere on a dashboard screen. The departures from
v2, and the product rules that survived it unchanged, are in
`docs/brief-amendments.md`, "§12 — replaced in full by design spec v2".

Executive, monthly performance, funnel, delivery, connections, reconciliation
and the workspace are all built. **Delivery tracking is real as of 19 September
2026**: work is uploaded to S3, tagged to one of the eleven configured
commitments and a period, approved or sent back by the client, and approved
artifacts are what the delivered figure counts. Mentions, the activity rail and
asset comments are still out — they are collaboration, not delivery tracking.

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

## Production database — Neon, up as of 18 September 2026

`neondb` on `ep-royal-cherry-b5xqgpoc` (us-east-2), PostgreSQL 18.6. Built from
empty: roles bootstrapped, 9 migrations applied, tenants seeded, preflight green.

| | |
| --- | --- |
| Tables in `public` | 38, **all** with RLS enabled and FORCE |
| `public` schema owner | `zeeraa_owner` (NOSUPERUSER, NOBYPASSRLS) |
| Roles with BYPASSRLS or SUPERUSER | none of the seven `zeeraa*` roles |
| `app.membership_index` | 2 rows, zero drift against `memberships` |
| Memberships | `hello@zeeraa.com` zeeraa_admin · `lshah@spartancapitalgroup.com` client_admin |
| `assertRlsEnforced` | ok |
| `assertTransactionLocalContext` | ok |

Neon's sample table `playing_with_neon` (20 rows) was dropped — `public` has to
be empty of anything without a policy or `assertRlsEnforced` refuses to serve.

**Endpoints.** The runtime roles use the pooled host
(`...-pooler...`, PgBouncer transaction mode, which is what
`assertTransactionLocalContext` requires and what `client.ts`'s
`prepare: false` is for). The owner and maintenance roles use the direct host,
because migrations take advisory locks. Put
`pnpm --filter @zeeraa/db preflight` in the Vercel build command so a wrong
endpoint breaks the deploy rather than quietly disabling isolation.

**The isolation model had to change to deploy at all.** The SECURITY DEFINER
policy helpers used to carry `SET app.maintenance = 'on'`; only a true
superuser can grant SET on a custom parameter, and Neon has none, so migration
0002 could not run. The helpers now read `app.membership_index`, a mirror in the
`app` schema with no grant to any application role. FORCE, the maintenance gate
and the absence of BYPASSRLS are all unchanged, 16 of 16 mutations are still
killed, and two new mutations cover the mirror's own failure modes. Full
reasoning in `docs/brief-amendments.md`, "§5 and §12 — the policy helpers no
longer elevate".

**Routine syncing is on Vercel Cron as of 18 September 2026.** `vercel.json`
schedules `/api/cron/sync` hourly; it runs the incremental path only — two days
of paid media, Salesforce since its last completed read — and measures 5–7
seconds against Spartan, inside the 60s function limit. Protected by a
`CRON_SECRET` bearer check that fails closed. The Inngest serve route and
module are gone, along with the dependency; the ninety-day backfill remains
`scripts/run-scheduled.ts` and the per-platform scripts, which is where §7's
durable-steps argument actually applies. See `docs/brief-amendments.md`,
"§7 — routine syncing runs on Vercel Cron, not Inngest".

"Sync now" now calls the same incremental path per tenant and reports the real
outcome in the UI rather than that an event was queued.

**Still to do before the app serves traffic.**

1. Set the Vercel environment from the connection strings and secrets generated
   during bring-up. `ENCRYPTION_KEY` is new, so the Google Ads and Salesforce
   credentials do not decrypt against it — re-run
   `pnpm --filter @zeeraa/db set-credentials spartan google_ads` and
   `... salesforce` against Neon.
2. Nothing is ingested there yet: 0 daily_metrics, 0 leads, 0 opportunities.
   Production starts empty and the first sync fills it. The 90-day
   `click_view` window is the one thing with an expiry, so the first
   `run-scheduled nightly` against Neon should not wait.
3. `CRON_SECRET` must be set in Vercel or the hourly endpoint refuses (503),
   and `ALOWARE_WEBHOOK_SECRET` likewise for the call webhook — both fail
   closed, so an unset secret is a refusing endpoint rather than an open one.
   `NEXTAUTH_URL` and the OAuth and Resend credentials are still unset for
   production, as are `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and
   `S3_SECRET_ACCESS_KEY` — without those four the workspace renders
   `Storage not configured` and the upload endpoints answer 503 naming them,
   rather than failing obscurely. `BLOB_READ_WRITE_TOKEN` and `INNGEST_*` are no
   longer used by anything.

## Three unmeasured items became measured (18 September 2026)

Four things on the funnel rendered `Not measured`. Three were recoverable from
data already in the org; the reasoning and the coverage limits are in
`docs/brief-amendments.md`, "§8 and §9.3 — three of the four unmeasured items
are now measured".

| Stage | Figure, trailing 90 days | Coverage limit shown on screen |
| --- | ---: | --- |
| UW approved | 114 | Field history begins 2026-03-20; silent before it |
| Offer rate | 58.8% (67 of 114) | Gated below a denominator of 10 |
| MQL | 649 | 57.6% of leads assessable |
| Declines | 362 deals (389 transitions) | 89% of closed-lost deals |

Over all 7,296 inbound leads the bar reads 1,206 qualified (16.5%), 2,903
unqualified (39.8%), 3,184 undeterminable (43.6%). The single largest
obstruction is `MIYB_Years_in_Business__c`, 1,075 leads.

**Three numbers on screen were wrong and are corrected.** Each was caught by
the figure looking implausible, and each had a different cause:

1. **MQL read 26 and a 0.7% qualification rate.** The stage was counted from
   `stage_events`, which are keyed by opportunity, so it counted the qualified
   leads that went on to convert. MQL is a judgement about a *lead*; migration
   0010 adds `qualified_leads` as a stage source and the rate is 17.0%.
2. **MQL → Application read 1,696%, then 68%.** The first was caught by a guard
   that fires when a ratio exceeds 100%. The second is the same non-nested
   populations at the right grain, looking perfectly plausible — applications
   are not drawn from MQLs, because the bar is computed from what a lead
   reported rather than being a gate. Nesting is now declared on the stage, not
   inferred from the arithmetic.
3. **Declines read 555 against 362 actual deals.** Bucket rows are distinct per
   *day*, so a re-underwritten deal counted twice, and the window total summed
   every month that overlapped the range. Buckets now count one deal once per
   stage per bucket, and a window total is a distinct count.

Also fixed while wiring it up: the writer no longer overwrites a stored MQL
verdict with a null one (a re-upsert without the bar would have erased
judgements), the band parser no longer drops a zero lower bound or reads the
`m` in "Months" as "million", and `reconcileDeletesAndMerges` clamps both
`getDeleted` window bounds instead of throwing the whole sync.

## Lender grain, and the offer rate that was not one (18 September 2026)

An audit of the org — prompted by an offer rate of 58.8% looking too high for
MCA — found that the funnel was reading lender decisions off the deal. Full
reasoning in `docs/brief-amendments.md`, "§8 — Offer rate is blocked, because it
was measuring data entry" and "§4, §8 and §9.3 — submissions are the grain the
funnel was missing".

**Offer rate is retired.** Approval and the first lender offer are the same
event: median 0.0 hours apart, 110 of 112 within an hour, and 98 of the offer
records predate the stage change. What the rate measured is whether somebody
typed a date into `Offer_Received_Date_Time__c` — 57 of 115 approved deals have
it, 112 hold an offer record. It also divided populations that do not nest: 10
of 67 offers belong to deals with no approval event.

**`csbs__Submission__c` is ingested at lender grain.** 1,427 submissions, 419
opportunities, 6 lenders, from 2026-06-18. One table, migration 0011, with the
usual RLS treatment plus two mutations and three isolation tests.

| | Submissions | Offered | Declined | Offer rate of decided |
| --- | ---: | ---: | ---: | ---: |
| CFG | 419 | 73 | 137 | 34.8% |
| Spartan Capital | 310 | 27 | 131 | 17.1% |
| Elevate Funding | 348 | 21 | 164 | 11.4% |
| Forward Financing | 347 | 9 | 158 | 5.4% |
| **All lenders** | **1,427** | **131** | **590** | **18.2%** |

706 submissions are undecided and excluded — 693 awaiting an answer, 13 that
never completed. They are on the metric, not in a caption: a reader assuming the
denominator is every submission is out by a factor of two.

**Decline reasons are measured, at lender grain.** 123 citations across 121
lender declines. Coverage is rendered per month and never summed, because the
field is being adopted: 0% of June's declines, 15.4% of July's, 9.1% of
August's, 30.5% of September's. A reason *per deal* stays blocked —
`Loss_Reason__c` is abandoned and a deal declined by three lenders has no single
reason in the CRM.

**The funnel no longer assumes stages progress in order.** Nesting is measured
per transition against the stage events, with `max_rate_leakage` (2%, a config
row) deciding whether a rate renders with its exclusion stated or is withheld.
Every stage card states how many of its deals were later declined — 47 of 67 at
Offer. The Salesforce sync reports `succeeded` again, the absent
`csbs__Decline_Reason__c` having been dropped from the mapping now that the
reason is read where it lives.

## Call tracking, from Aloware (18 September 2026)

Built as a direct Aloware integration, not by reading the 30,093
`Aloware_Call__c` records in Salesforce: that object is a copy whose
completeness depends on the vendor's own CRM integration, and a gap in it would
look here like a quiet day on the phones. Full reasoning in
`docs/brief-amendments.md`, "§7 and §9 — call tracking, from Aloware directly".

**The blocked state was wrong, not merely stale.** It said the vendor had not
been selected. Aloware has been live since June.

| | |
| --- | ---: |
| Calls imported (19 Jun – 17 Sep) | 28,863 |
| SMS skipped, counted not ingested | 252 |
| Connected (talk time ≥ 30s) | 3,503 |
| Attempted | 23,358 |
| — of which answered, under the threshold | 19,852 |
| Abandoned, excluded from both | 2,002 |
| Calls matched to a lead | 27,382 of 28,862 (94.9%) |
| Speed to lead, median | 11h 35m (p90 11d 18h) |
| Called within five minutes | 15.1% of leads called |
| Attempts per lead | mean 7.6, median 4 |

`completed` is not a conversation: the vendor marks 26,311 calls completed and
13,376 of those talked for under ten seconds. `connected` therefore requires
talk time past `aloware.connectedMinTalkSeconds` — a config row, default 30s,
rendered on the card because the sensitivity is steep (23,355 connected at 1s,
9,979 at 10s, 3,503 at 30s).

**The CSV lives in `data/private/`, which is gitignored, and is PII.** Only the
columns needed are ingested; names, emails, note bodies and recordings are not
read. The two PII columns stored — contact number and agent name — appear on no
screen.

**Going forward:** `POST /api/webhooks/aloware/{tenant}`, bearer-authenticated
with `ALOWARE_WEBHOOK_SECRET`, idempotent on Communication ID because that is
the upsert key. Verified end to end: a repeated post produces one row, an SMS
is rejected with its reason, a bad body is a 400, a wrong secret is a 404.

**Three bugs this surfaced and fixed.** `sync-salesforce --since` was read and
documented but never passed to the sync, only to the click-ID backfill — so a
"full re-pull" silently ran incrementally. The export's timestamps carry no
timezone, and read as UTC every call would have landed four hours early, which
would have looked like a slow desk rather than a bug. And the seed's connection
upsert key includes the account identifier, so renaming one inserted a second
row and left the stale one rendering — now pruned, but only for rows holding no
credentials.

## The workspace, and delivery counts that come from it (19 September 2026)

Delivery read `Not recorded` against all eleven commitments because nothing
wrote to `assets` or `deliverable_records`. The loop is now closed: upload →
tag to a commitment and a period → client approves or sends back → the delivered
figure moves. Full reasoning in `docs/brief-amendments.md`, "§10 and §14 — asset
storage is S3, and a delivered count is derived from approvals".

**Storage is AWS S3, not Vercel Blob.** The client's decision. One private
bucket, all public access blocked, keys `tenant/{tenant_id}/assets/{id}/v{n}/…`,
uploads by presigned PUT straight from the browser and downloads by a signed GET
produced per request behind an RLS-checked read. The application's IAM policy
carries no `s3:ListBucket` — so a leaked credential cannot enumerate what other
tenants hold — and no `s3:DeleteObject`, which makes "old versions are never
deleted" a property of the credentials. Bucket, CORS and IAM in
`docs/asset-storage.md`; `BLOB_READ_WRITE_TOKEN` is gone from `.env.example`.

**Three states, not two.** `Not recorded` where no artifact exists and no count
was written; `0` once an artifact is in front of the client but none is approved
yet; the approved count thereafter. A draft in Zeeraa's own column triggers
nothing. Approved artifacts decide the figure wherever they exist, and a
hand-recorded count — for backlinks, tracked prompts, concurrent tests, which
produce no artifact — is used only where there are none. Where both exist the
tally is stated beside the figure and never added to it.

**A superseded version counts toward nothing**, so one article approved at v1
and again at v2 is one article delivered. Migration 0013 adds the partial unique
index that keeps a version chain a chain.

**Only a client admin can approve, and that is a trigger rather than a hidden
button.** `app.enforce_asset_review_authority()` on `assets`: into `approved` or
`changes_requested` requires `client_admin`, into `submitted`/`published`
requires a Zeeraa role, and the approver column must name the user in context. A
Zeeraa admin holds every other power in this product and deliberately not this
one — a delivered figure Zeeraa could raise on its own behalf is not a
compliance record. Thirteen tests in `packages/db/test/asset-review.test.ts`;
six new mutations, **26 of 26 killed**.

**Two bugs found and fixed while building it.**

1. The correlated subquery that asks "does a later version of this row exist"
   rendered the outer column unqualified, so it bound to the inner alias and the
   condition became `later.supersedes_asset_id = later.id` — never true, no
   error, every row reported as not superseded. It would have double-counted the
   first article approved at v1 and again at v2. It is now one named constant in
   `apps/web/src/lib/asset-sql.ts` with a test on its generated SQL.
2. `Items delivered` on the delivery view summed every commitment's delivered
   figure — pieces plus pages plus links. Invisible while everything read `Not
   recorded`; with real counts it reported 37. Replaced by `Artifacts approved`,
   which is one unit.

Verified end to end against a local MinIO standing in for S3: upload, submit,
a Zeeraa admin refused at approval, the client admin approving, a rejection with
its reason, a v2 replacing a sent-back v1, the delivered figure moving 1 → 2 and
not 1 → 3, the object returning 403 to an anonymous GET, and the signed
redirect serving the file. Screenshots at 1440px and 390px, no horizontal page
scroll at either.

## Blocked

- **All six click-ID fields are mapped Lead → Opportunity (17 September 2026),
  and the mapped route is switched on — but it changes nothing yet.** Salesforce
  lead field mapping copies at the moment of conversion and never
  retrospectively, so all 712 existing opportunities still hold null and
  coverage is unmoved. It starts paying from the next conversion onward. Until
  then `backfillClickIdsFromConvertedLeads` is still doing all the work.
- **`acq_fbclid__c` is populated on 969 leads and the platform is not read.**
  The Lead mapping names `gclid__c` only, so those leads currently count as
  carrying no click at all. They are Meta clicks, and the deals behind them are
  sitting in the unattributed bucket inflating Google Ads' plausible range.
  Reading it is a one-line config change; the reason it has not been made is
  that Meta has no connector, so a Meta channel row would show deals against no
  spend — the exact shape the separation rule forbids. Decide between
  connecting Meta and representing an unconnected-but-known channel.
- **`Gbraid__c`, `Wbraid__c` are mapped in Salesforce but empty (0 leads), and
  deliberately not in the connector mapping.** One platform key holds one field
  and Google's `click_view` only ever returns `gclid`, so a gbraid touch could
  never resolve to a campaign.
- **`Lead.TTCLID__c` has no Opportunity counterpart.** TikTok is not in the
  engagement; leave it or create the field deliberately.
- **`Opportunity.csbs__Decline_Reason__c` does not exist**, and is no longer
  mapped. It was kept mapped on purpose while the reason was unmeasured, so
  validation would keep reporting it; the reason is now read from the submission
  object, so the sync reports `succeeded` rather than `partial` forever.
- **Decline reasons are measured at lender grain; a reason per *deal* is not.**
  `Decline_Reason__c` on `csbs__Submission__c` carries them, at rising monthly
  coverage. `Loss_Reason__c` on Opportunity was filled in on every closed-lost
  deal through January 2025 and then abandoned — 0 of 133 in July 2026, 2 of 132
  in August, 1 of 66 in September — and a deal declined by three lenders for
  three reasons has no single reason in the CRM.
- **Revenue bands on Opportunity stay blocked.** `Approved_MCA_Amount__c` and
  `Net_Funding_Amount__c` report 100% populated and hold six real values
  between them. Nothing reads them, and nothing should.
- **MQL is measured, with 43.6% of leads undeterminable.** The bar reads banded
  picklist answers as of 18 September 2026 — 16.5% qualified, 39.8%
  unqualified. What remains blocked is one field: `MIYB_Years_in_Business__c`
  holds the only time-in-business answer for 1,075 leads and its values are
  opaque codes. A decode key from the client converts those leads from
  undeterminable to an answer; guessing at it would not. Tracked as
  `mql_time_in_business_decode`.
- **Call tracking is built and no longer blocked.** Aloware, imported directly.
  What remains is operational rather than a dependency: the webhook
  subscription has to be pointed at
  `/api/webhooks/aloware/spartan` in the Aloware console, and
  `ALOWARE_WEBHOOK_SECRET` set on the deployment, before live calls flow. Until
  then the record ends at the export's last call, 17 September 2026.
- Microsoft Ads, Meta, LinkedIn Ads, GA4, Search Console, Semrush: not started.

## Phase 4 progress

Done:

- **The whole UI, rebuilt against design spec v2.** Not a restyle of the old
  components: the layout shell, the card system, the chart set and every screen
  were written from the shell down.
  - `components/shell` — fixed 240px sidebar, collapsible to 64px and
    off-canvas below `lg`, with the tenant mark, accent stripe, role and
    switcher; a per-page 64px top bar carrying the breadcrumb, title, date
    range, attribution toggle, export, print and "Sync now".
  - `components/ui` — `Card`, `CardHeader`, `EmptyLine`, `Badge`, `Delta`,
    `Progress`, `Ring`, `InfoTip`, `Segmented`, `Button`, `MethodDrawer`.
  - `components/charts` — `AreaSeries`, `StackedBars`, `RangeBars`,
    `DivergingBars`, `MiniChart`, and `chart-kit` holding the palette, the
    tooltip and the animate-once rule.
  - **The prose is gone.** Every methodology note, caveat and "why this is not
    measured" now lives in an ⓘ, in a `Not measured` badge's tooltip, in the
    "How this is measured" drawer, or as a one-line row in the data-quality
    card. The drawer's contents are also expanded into the print sheet, because
    a QBR printout that carries the figures without their definitions is the
    dispute this product exists to prevent.
- **Two metric config rows added** — `attributed_share` and `applications`, both
  `improvement_direction: 'up'`. A KPI card colours its delta only where
  configuration declares a direction; without a row it renders the sign and the
  arrow in grey. Paid media spend deliberately has no row: spending less is not
  an achievement and spending more is not a failure.
- **CSV export** at `/api/export/{tenant}/{performance|funnel|delivery}`,
  reading the same search params and the same query functions as the screen, so
  it cannot drift from what is displayed. Blocked stages export as an empty cell
  with the reason in a notes column, never as a zero; the unattributed row has
  no spend or cost-per-deal cells at all.
- **"Sync now"** at `/api/sync/{tenant}?platform=`, `zeeraa_admin` only, running
  the same incremental sync the hourly Vercel Cron endpoint runs, waiting for it
  and reporting the real per-platform outcome, duration and remedy.

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

- **The schedule runs.** `pnpm --filter @zeeraa/jobs run-scheduled nightly|hourly`
  drives the same sync functions the Inngest handlers call, so cron can run the
  pipeline on any box from tonight without waiting for a deployment.
  `scripts-crontab.example` has the entries. Verified end to end.
- **A real Lead stage.** The funnel now runs Lead → MQL → Application → SQL →
  UW approved → Offer → Funded. Lead counts the inbound `leads` table; what used
  to be called Lead is Application, which is what `opportunity_created` actually
  stamps. A stage declares its grain in `funnel_stages.source`.
- **Funnel view** with a population selector — all sources, each channel, or
  unattributed — where both halves of every rate come from the selected
  population. It also shows the transitions that *can* be measured across a
  blocked stage, rather than leaving the funnel looking severed.
- **Four charts** on the performance screen.

Next, in order:

1. **Finish the Vercel environment.** The hourly cron is the schedule now
   (Inngest is gone); what remains is setting the connection strings, secrets
   and `CRON_SECRET` in the project, and running the first backfill against
   Neon.
2. **The rest of phase 5.** Uploads, versioning and the approval flow are done
   (19 September 2026). What remains is collaboration: the mention picker,
   `@mentions`, asset comments, the activity rail and notifications. Also
   unbuilt: recording a hand-kept count from the UI — the `manual` rows are
   written by hand in SQL today, which is fine for backlinks and prompts but
   will not stay fine.
3. Chase the Opportunity click-ID fields and the decline-reason field.
4. Campaign and keyword-tier drill-down on the performance table. The breakdown
   tab set is on screen with each dimension's blocker stated; campaign is the
   one that is Zeeraa build work rather than a CRM gap.
5. **Decide Meta.** `acq_fbclid__c` is populated on 969 leads and is not read,
   because a Meta channel row would show deals against no spend. That decision
   now has a visible home: it is a row in the data-quality card on every screen
   that depends on it.

## Scheduling: where it really stands (17 September 2026)

The click ledger is **complete and settled**: 90 of 90 days, 2026-06-20 to
2026-09-17, every day `succeeded`. Tonight's run was executed by hand before
pausing, so nothing is outstanding.

**The earlier framing in this file was wrong and is corrected here.** It said
holes start appearing the moment a night is missed. They do not. The backfill
re-pulls a trailing 90-day window and the ledger claims whatever is pending, so
a missed night is picked up by the next run. A day is lost permanently only if
it ages past the 90-day `click_view` window without ever having been fetched —
which now requires the schedule to be dead for months, not for one night. The
urgency was real while the window was uncaptured; it is not any more.

`crontab scripts-crontab.example` is installed and `cron` is running. It was
proved to work rather than assumed: a temporary one-minute entry fired and
executed the job, then was removed.

**It will not fire tonight, and nothing installed on this machine can.** This
Codespace has `idle_timeout_minutes: 30`, so the container suspends half an hour
after the last interaction and a suspended container runs no cron. Verify with:

```bash
gh api "/user/codespaces/$CODESPACE_NAME" --jq .idle_timeout_minutes
```

So the crontab is real and correct and will run whenever the Codespace happens
to be awake at the hour — which is a convenience, not a schedule. The only
unattended schedule is the hourly Vercel Cron entry in `vercel.json`, and it
needs the app deployed with `CRON_SECRET` set (Inngest is gone as of
18 September 2026). Until then: run
`pnpm --filter @zeeraa/jobs run-scheduled nightly` by hand at the end of any
working session, which takes about eight seconds.

## The nightly fan-out was a silent no-op until 17 September 2026

`listGoogleAdsConnections` and `listSalesforceConnections` ran on the ingestion
role with no tenant context. `job_read_connections` is
`tenant_id = app.current_tenant_id()`, so they read zero rows: every scheduled
run would have dispatched nothing, reported success, and let the `click_view`
window age out uningested. Failing closed was correct; asking on the wrong
connection was the bug. They now go through `withMaintenance` on
`getMaintenanceDb()` — orchestration, reading two uuids, with every byte of
actual sync work still scoped by `withJobTenant`. Two tests in
`packages/db/test/job-role.test.ts` hold the line.

## Lead-to-application, now that the two are separate stages

The rate that was hidden while one stage did both jobs, over the trailing 90
days:

| Population | Leads | Applications | Rate |
| --- | ---: | ---: | ---: |
| All sources | 3,748 | 436 | 11.6% |
| Google Ads | 1,091 | 193 | **17.7%** |
| Unattributed | 2,657 | 243 | 9.1% |

Google Ads leads become applications at roughly twice the rate of leads nobody
can attribute. Both halves of each rate come from the same population.

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

The mutation test **drops and rebuilds the schema it points at**, so it needs a
throwaway database rather than the development one:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5433/zeeraa_mut \
DATABASE_URL_OWNER=postgres://zeeraa_owner:zeeraa_owner@localhost:5433/zeeraa_mut \
  npx tsx packages/db/scripts/mutation-test.ts
```

`zeeraa_mut` exists on the local cluster for this. It takes a few minutes — it
re-migrates and runs the whole isolation suite once per mutation. 16 of 16
killed as of 18 September 2026.

Looking at the UI locally: neither sign-in provider works without credentials,
so `/api/dev-signin?email=admin@zeeraa.com` mints a real session for a seeded
user and redirects. It is not an authorization bypass — RLS and `memberships`
still decide everything afterwards — and it refuses unless `NODE_ENV` is not
production *and* the auth database is on localhost.

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
