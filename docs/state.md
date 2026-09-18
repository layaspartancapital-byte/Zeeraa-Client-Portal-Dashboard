# Running state

Where the build actually is, so a fresh session does not have to reconstruct it
from commit history. Short by design: current phase, what is done, what is
blocked, what is next. Updated at the end of every session.

**Last updated: 18 September 2026, end of session.**

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
and the workspace shell are all built. Workspace *content* — uploads,
versioning, mentions, approvals — is still phase 5.

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
3. `NEXTAUTH_URL`, the OAuth and Resend credentials, `INNGEST_*` and
   `BLOB_READ_WRITE_TOKEN` are still unset for production.

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
- **`Opportunity.csbs__Decline_Reason__c` does not exist.** Dropped from the
  query and reported; the Salesforce sync reports `partial` for this alone.
- **MQL is undetermined for most leads.** The bar's two inputs are close to
  empty on inbound leads.
- **Call tracking.** Vendor not selected.
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
- **"Sync now"** at `/api/sync/{tenant}?platform=`, `zeeraa_admin` only, sending
  the same Inngest event the nightly schedule sends. Until the app is registered
  with Inngest it reports that plainly and names `run-scheduled` as the path
  that works today.

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

1. **Deploy, and register with Inngest.** The cron fallback above is running the
   pipeline; the durable-step version is what should run it in the end.
2. **Phase 5: the workspace.** Uploads to blob storage under
   `tenant/{tenant_id}/`, signed and authorisation-checked URLs, versioning,
   the mention picker, and the approval flow. The board, the columns, the drop
   zone and the activity rail are built and read real rows; there are none yet.
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
unattended schedule is the Inngest one, and it needs the app deployed and
registered. Until then: run `pnpm --filter @zeeraa/jobs run-scheduled nightly`
by hand at the end of any working session, which takes about eight seconds.

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
